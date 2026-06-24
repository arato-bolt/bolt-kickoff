import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY') || '';

const BASE_PROMPT = `Retouch this product photo for premium e-commerce catalog use. Preserve the exact product shape, proportions, materials, colors and all visible features (ports, logos, labels, buttons, connectors). Place the product on a clean, pure white seamless background (#FFFFFF). Apply soft, even studio lighting with a realistic soft contact shadow beneath the product. Slightly enhance sharpness and contrast without altering the product's true colors. Apply controlled, realistic reflections on glossy, metal or glass surfaces only where the original photo shows them — avoid exaggerated or fake-looking reflections. Do not change the product's design, proportions, or add/remove any parts. Do not add any text, watermark or logo that is not already present in the original photo.`;

const CATEGORIA_EXTRA: Record<string, string> = {
  'Cabeamento': ' Keep cable coils neat, natural and undamaged.',
  'Fibra Óptica': ' Preserve connector tips and fiber colors exactly as shown.',
  'Componentes PC': ' Preserve all PCB details, chip markings, pins and connectors clearly visible.',
};

function buildPrompt(categoria?: string | null) {
  return BASE_PROMPT + (categoria && CATEGORIA_EXTRA[categoria] ? CATEGORIA_EXTRA[categoria] : '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { job_id, limit = 5, quality = 'medium' } = await req.json();
    if (!job_id) return json({ error: 'job_id required' }, 400);
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: itemsToProcess } = await sb.from('image_items').select('*').eq('job_id', job_id).eq('status', 'pending').limit(limit);
    if (!itemsToProcess?.length) return json({ ok: true, processados: 0, restantes: 0 });

    let ok = 0, err = 0;
    for (const item of itemsToProcess) {
      try {
        await sb.from('image_items').update({ status: 'processing' }).eq('id', item.id);
        const { data: fileBlob, error: dlErr } = await sb.storage.from('product-images').download(item.storage_original);
        if (dlErr || !fileBlob) throw new Error(dlErr?.message || 'download falhou');

        const prompt = buildPrompt(item.categoria);
        const form = new FormData();
        form.append('model', 'gpt-image-1');
        form.append('image', fileBlob, 'original.png');
        form.append('prompt', prompt);
        form.append('size', '1024x1024');
        form.append('quality', quality);
        form.append('n', '1');

        const resp = await fetch('https://api.openai.com/v1/images/edits', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
          body: form,
          signal: AbortSignal.timeout(60000),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error?.message || 'erro OpenAI');
        const b64 = data.data?.[0]?.b64_json;
        if (!b64) throw new Error('sem imagem retornada');

        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const tratadaPath = item.storage_original.replace('/original/', '/tratada/').replace(/\.[^.]+$/, '.png');
        const { error: upErr } = await sb.storage.from('product-images').upload(tratadaPath, bytes, { contentType: 'image/png', upsert: true });
        if (upErr) throw new Error(upErr.message);

        await sb.from('image_items').update({
          status: 'done', storage_tratada: tratadaPath, prompt_usado: prompt, processed_at: new Date().toISOString(),
        }).eq('id', item.id);
        ok++;
      } catch (e: any) {
        await sb.from('image_items').update({ status: 'error', error_msg: e.message }).eq('id', item.id);
        err++;
      }
    }
    const { count: restantes } = await sb.from('image_items').select('id', { count: 'exact', head: true }).eq('job_id', job_id).eq('status', 'pending');
    return json({ ok: true, processados: ok, erros: err, restantes: restantes || 0 });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});

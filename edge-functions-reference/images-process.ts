import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY') || '';

const BASE_PROMPT = `Retouch the provided product photo for premium e-commerce catalog use.
Preserve the exact same product: its geometry, proportions, materials, colors, label, logo, QR codes, screws, borders, connectors, ports, buttons and all visible printed text and markings.
Do not redesign, replace, invent, simplify or reinterpret any element of the product. Do not alter brand marks or printed label content.
If small printed text is not fully readable in the source image, preserve its visual appearance without inventing new characters.
Improve only: background (replace with a clean, pure white seamless background, #FFFFFF), exposure, contrast, sharpness, realistic studio lighting and a soft, realistic contact shadow beneath the product.
Apply controlled, realistic reflections on glossy, metal or glass surfaces only where the original photo already shows them — avoid exaggerated or fake-looking reflections.
Keep the product front-facing and centered, at the same proportions as the original.
The result must look like a clean e-commerce catalog retouch of the same physical object — not a newly generated or redesigned product.`;

const CATEGORIA_EXTRA: Record<string, string> = {
  'Cabeamento': ' Keep cable coils neat, natural and undamaged.',
  'Fibra Óptica': ' Preserve connector tips and fiber colors exactly as shown.',
  'Componentes PC': ' Preserve all PCB details, chip markings, pins and connectors clearly visible.',
};

function buildPrompt(categoria?: string | null) {
  return BASE_PROMPT + (categoria && CATEGORIA_EXTRA[categoria] ? CATEGORIA_EXTRA[categoria] : '');
}

// Protege chamadas que poderiam travar sem resposta (download/upload do Storage),
// que nao tem suporte nativo a AbortSignal no supabase-js. Sem isso, uma chamada
// presa nao e' pega pelo nosso catch e a function roda até a plataforma matar aos ~150s.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}: timeout apos ${ms}ms`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// Preco por token (gpt-image-2): https://developers.openai.com/api/docs/pricing
const PRICE_INPUT_IMAGE_PER_1M = 8.00;
const PRICE_INPUT_TEXT_PER_1M = 5.00;
const PRICE_OUTPUT_IMAGE_PER_1M = 30.00;

function estimateCost(usage: any): number {
  if (!usage) return 0;
  const imgIn = usage.input_tokens_details?.image_tokens || 0;
  const txtIn = usage.input_tokens_details?.text_tokens || (usage.input_tokens && !usage.input_tokens_details ? usage.input_tokens : 0);
  const imgOut = usage.output_tokens || 0;
  return (imgIn / 1e6) * PRICE_INPUT_IMAGE_PER_1M + (txtIn / 1e6) * PRICE_INPUT_TEXT_PER_1M + (imgOut / 1e6) * PRICE_OUTPUT_IMAGE_PER_1M;
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
      const startedAt = Date.now();
      try {
        await sb.from('image_items').update({ status: 'processing' }).eq('id', item.id);
        const { data: fileBlob, error: dlErr } = await withTimeout(
          sb.storage.from('product-images').download(item.storage_original), 15000, 'download',
        );
        if (dlErr || !fileBlob) throw new Error(dlErr?.message || 'download falhou');

        const prompt = buildPrompt(item.categoria);
        const form = new FormData();
        form.append('model', 'gpt-image-2');
        form.append('image', fileBlob, 'original.png');
        form.append('prompt', prompt);
        form.append('size', '1024x1024');
        form.append('quality', quality);
        form.append('n', '1');

        const resp = await fetch('https://api.openai.com/v1/images/edits', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
          body: form,
          signal: AbortSignal.timeout(100000),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error?.message || 'erro OpenAI');
        const b64 = data.data?.[0]?.b64_json;
        if (!b64) throw new Error('sem imagem retornada');

        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const tratadaPath = item.storage_original.replace('/original/', '/tratada/').replace(/\.[^.]+$/, '.png');
        const { error: upErr } = await withTimeout(
          sb.storage.from('product-images').upload(tratadaPath, bytes, { contentType: 'image/png', upsert: true }), 15000, 'upload',
        );
        if (upErr) throw new Error(upErr.message);

        const usage = data.usage;
        await sb.from('image_items').update({
          status: 'done', storage_tratada: tratadaPath, prompt_usado: prompt, processed_at: new Date().toISOString(),
          tokens_input: usage?.input_tokens ?? null,
          tokens_output: usage?.output_tokens ?? null,
          custo_estimado: usage ? estimateCost(usage) : null,
          duracao_ms: Date.now() - startedAt,
        }).eq('id', item.id);
        ok++;
      } catch (e: any) {
        await sb.from('image_items').update({ status: 'error', error_msg: e.message, duracao_ms: Date.now() - startedAt }).eq('id', item.id);
        err++;
      }
    }
    const { count: restantes } = await sb.from('image_items').select('id', { count: 'exact', head: true }).eq('job_id', job_id).eq('status', 'pending');
    return json({ ok: true, processados: ok, erros: err, restantes: restantes || 0 });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});

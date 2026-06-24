import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const form = await req.formData();
    const nomeLote = String(form.get('nome_lote') || `Lote ${new Date().toISOString().slice(0, 10)}`);
    const files = form.getAll('arquivos') as File[];
    const skus = form.getAll('skus') as string[];
    const categorias = form.getAll('categorias') as string[];
    if (!files.length) return json({ error: 'nenhum arquivo enviado' }, 400);

    const { data: job, error: jobErr } = await sb.from('image_jobs')
      .insert({ nome_lote: nomeLote, total_imagens: files.length, status: 'pending' })
      .select().single();
    if (jobErr) return json({ error: jobErr.message }, 500);

    const items: any[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const itemId = crypto.randomUUID();
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `${job.id}/original/${itemId}.${ext}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { error: upErr } = await sb.storage.from('product-images').upload(path, bytes, { contentType: file.type || 'image/jpeg' });
      if (upErr) continue;
      items.push({
        id: itemId, job_id: job.id,
        sku: skus[i] || null,
        nome_produto: file.name,
        categoria: categorias[i] || null,
        storage_original: path, status: 'pending',
      });
    }
    if (items.length) await sb.from('image_items').insert(items);

    return json({ ok: true, job_id: job.id, total: files.length, enviados: items.length });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});

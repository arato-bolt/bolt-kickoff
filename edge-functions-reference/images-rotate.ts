import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const form = await req.formData();
    const item_id = form.get('item_id') as string;
    const file = form.get('image') as File;
    if (!item_id || !file) return json({ error: 'item_id e image obrigatorios' }, 400);

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: item, error: itemErr } = await sb.from('image_items').select('storage_tratada').eq('id', item_id).single();
    if (itemErr || !item?.storage_tratada) return json({ error: 'item nao encontrado ou sem imagem tratada' }, 404);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error: upErr } = await sb.storage
      .from('product-images')
      .upload(item.storage_tratada, bytes, { contentType: 'image/png', upsert: true });
    if (upErr) return json({ error: upErr.message }, 500);

    await sb.from('image_items').update({ processed_at: new Date().toISOString() }).eq('id', item_id);
    return json({ ok: true });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});

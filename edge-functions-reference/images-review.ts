import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    if (req.method === 'GET') {
      const url = new URL(req.url);
      const job_id = url.searchParams.get('job_id');
      const status = url.searchParams.get('status') || 'done';
      const limit = Number(url.searchParams.get('limit') || 20);
      const offset = Number(url.searchParams.get('offset') || 0);

      let q = sb.from('image_items').select('*').eq('status', status).order('created_at').range(offset, offset + limit - 1);
      if (job_id) q = q.eq('job_id', job_id);
      const { data, error } = await q;
      if (error) return json({ error: error.message }, 500);

      const withUrls = (data || []).map((it: any) => ({
        ...it,
        url_original: sb.storage.from('product-images').getPublicUrl(it.storage_original).data.publicUrl,
        url_tratada: it.storage_tratada ? sb.storage.from('product-images').getPublicUrl(it.storage_tratada).data.publicUrl : null,
      }));
      return json({ ok: true, items: withUrls });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      if (body.action === 'approve') {
        await sb.from('image_items').update({ status: 'aprovado' }).eq('id', body.item_id);
        return json({ ok: true });
      }
      if (body.action === 'reject') {
        await sb.from('image_items').update({ status: 'reprovado', motivo_reprovacao: body.motivo || null }).eq('id', body.item_id);
        return json({ ok: true });
      }
      if (body.action === 'reprocess') {
        await sb.from('image_items').update({ status: 'pending', error_msg: null }).eq('id', body.item_id);
        return json({ ok: true });
      }
      if (body.action === 'fix') {
        // Reprovacao com instrucao de correcao: volta pra fila e roda de novo com
        // o prompt base + a correcao especifica pedida pelo revisor (ex: "tirar plastico").
        if (!body.instrucao) return json({ error: 'instrucao obrigatoria' }, 400);
        await sb.from('image_items').update({
          status: 'pending', error_msg: null, motivo_reprovacao: body.instrucao, prompt_correcao: body.instrucao,
        }).eq('id', body.item_id);
        return json({ ok: true });
      }
      return json({ error: 'action invalida' }, 400);
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});

-- ========== ESTUDIO DE IMAGENS — SCHEMA ==========

CREATE TABLE IF NOT EXISTS image_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome_lote text,
  status text DEFAULT 'pending',
  total_imagens int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS image_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES image_jobs(id) ON DELETE CASCADE,
  sku text,
  nome_produto text,
  categoria text,
  storage_original text,
  storage_tratada text,
  prompt_usado text,
  status text DEFAULT 'pending', -- pending|processing|done|error|aprovado|reprovado
  motivo_reprovacao text,
  error_msg text,
  created_at timestamptz DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_image_items_job ON image_items(job_id);
CREATE INDEX IF NOT EXISTS idx_image_items_status ON image_items(status);

GRANT SELECT, INSERT, UPDATE, DELETE ON image_jobs, image_items TO anon, authenticated;

-- Bucket público (servido direto via URL, sem precisar de signed URL)
-- Todo upload/download passa pela Edge Function com service_role, então
-- não precisamos de policy de storage para anon/authenticated.
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-images', 'product-images', true)
ON CONFLICT (id) DO NOTHING;

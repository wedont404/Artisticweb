-- ============================================================
-- 0010  STORAGE bucket for product photos
-- Anyone can VIEW photos (public bucket). Only admins can upload/replace/delete.
-- Max 1 MB, webp / jpeg / png only (keeps the site fast on mobile data).
-- ============================================================

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets')
     and exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'objects') then

    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('product-images', 'product-images', true, 1048576, array['image/webp', 'image/jpeg', 'image/png'])
    on conflict (id) do update
      set public = excluded.public,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;

    drop policy if exists "dk product images admin write" on storage.objects;
    create policy "dk product images admin write" on storage.objects
      for all to authenticated
      using (bucket_id = 'product-images' and public.is_admin())
      with check (bucket_id = 'product-images' and public.is_admin());
  else
    raise notice 'storage schema not found - skipping product-images bucket (not Supabase?)';
  end if;
exception when insufficient_privilege then
  raise notice 'No permission to configure storage - create a public bucket named product-images in the dashboard.';
end $$;

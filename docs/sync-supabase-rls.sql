-- 为「星露谷 PC↔手机实时同步」授权 anon 读写 ai-phone-backup 桶下的 sync/ 前缀。
-- 用法：在 Supabase 项目 → SQL Editor 里贴整段执行（一次性）。
-- 原理：Storage 对 ai-phone-backup 桶默认拒绝匿名写入（RLS）。这里建三条精确策略，
--       只放行路径以 sync/ 开头的对象给 anon，其余区域仍保持匿名无权限。

-- 允许匿名在 ai-phone-backup 桶的 sync/ 前缀下插入(上传)对象
create policy "anon sync insert"
  on storage.objects for insert
  to anon
  with check (
    bucket_id = 'ai-phone-backup'
    and left((storage.foldername(name))[1], 5) = 'sync'
  );

-- 允许匿名读取(下载) sync/ 前缀下的对象
create policy "anon sync select"
  on storage.objects for select
  to anon
  using (
    bucket_id = 'ai-phone-backup'
    and left((storage.foldername(name))[1], 5) = 'sync'
  );

-- 允许匿名删除自己上传/读取过的 sync/ 前缀对象（探针清理、认领去重用）
create policy "anon sync delete"
  on storage.objects for delete
  to anon
  using (
    bucket_id = 'ai-phone-backup'
    and left((storage.foldername(name))[1], 5) = 'sync'
  );
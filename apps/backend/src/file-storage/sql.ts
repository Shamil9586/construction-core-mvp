/**
 * "This attachments row really holds a non-empty file" as a pure-SQL fact, for every provider:
 *   LOCAL        — bytes persisted in `content`, at least one byte (all records created before BITRIX-DISK-1);
 *   anything else — a verified external reference: an external id AND a positive size recorded by the upload (the provider
 *                  verified the stored size before the Core record was written; the CHECK in the migration pins the same rule).
 * Documentary-evidence rules (a scheme counts only when file-backed) must use this, never `content IS NOT NULL`.
 */
export const attachmentHasContentSql = (alias = 'a') => `((${alias}.file_provider='LOCAL' AND ${alias}.content IS NOT NULL AND octet_length(${alias}.content)>0)
    OR (${alias}.file_provider<>'LOCAL' AND ${alias}.external_file_id IS NOT NULL AND length(trim(${alias}.external_file_id))>0 AND coalesce(${alias}.size_bytes,0)>0))`;

const sorts = {
  date: {
    column: "created_at",
    direction: "DESC",
    operator: "<",
    key: "created_at",
  },
  name: {
    column: "name COLLATE NOCASE",
    direction: "ASC",
    operator: ">",
    key: "name",
  },
  size: {
    column: "size_bytes",
    direction: "DESC",
    operator: "<",
    key: "size_bytes",
  },
};
const sections = ["drive", "all", "favorites", "photos", "trash"];
const pageSize = 80;
const pageNumber = (value, fallback) =>
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= Number.MAX_SAFE_INTEGER / pageSize
    ? value
    : fallback;

export function catalogListing(input, libraryId) {
  const section = sections.includes(input.section) ? input.section : "drive";
  const folderId = section === "drive" ? input.folderId || null : null;
  const search = String(input.search || "");
  const tag = String(input.tag || "");
  const sortName = Object.hasOwn(sorts, input.sort) ? input.sort : "date";
  const sort = sorts[sortName];
  const where = [
    "library_id = ?",
    section === "trash" ? "trashed_at IS NOT NULL" : "trashed_at IS NULL",
  ];
  const params = [libraryId];
  if (section === "drive") {
    where.push("folder_id IS ?");
    params.push(folderId);
  }
  if (section === "favorites") where.push("favorite = 1");
  if (section === "photos")
    where.push(
      "(mime_type LIKE 'image/%' OR mime_type LIKE 'video/%' OR LOWER(name) LIKE '%.heic' OR LOWER(name) LIKE '%.heif' OR LOWER(name) LIKE '%.pxz' OR LOWER(mime_type) = 'application/pxz')",
    );
  if (search) {
    where.push(
      "(name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(jr_files.tags) WHERE value LIKE ? ESCAPE '\\'))",
    );
    const term = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    params.push(term, term);
  }
  if (tag) {
    where.push(
      "EXISTS (SELECT 1 FROM json_each(jr_files.tags) WHERE value = ?)",
    );
    params.push(tag);
  }
  const page = pageNumber(input.page, 1);
  const throughPage = Math.min(
    page + 4,
    Math.max(page, pageNumber(input.throughPage, page)),
  );
  const limit = (throughPage - page + 1) * pageSize;
  const cursor = input.cursor;
  const after =
    typeof cursor?.id === "string" &&
    (sortName === "size"
      ? Number.isFinite(cursor.value)
      : typeof cursor.value === "string")
      ? cursor
      : null;
  const offset = after ? 0 : (page - 1) * pageSize;
  const clause = where.join(" AND ");
  const sortTuple = `(${sort.column}, id)`;
  const order = `ORDER BY ${sort.column} ${sort.direction}, id ${sort.direction}`;
  const key = JSON.stringify([section, folderId, search, tag, sortName]);
  const conditions = (after, through) => {
    const filters = [clause];
    const values = [...params];
    if (after) {
      filters.push(`${sortTuple} ${sort.operator} (?, ?)`);
      values.push(after.value, after.id);
    }
    if (through) {
      const inclusive = sort.operator === "<" ? ">=" : "<=";
      filters.push(`${sortTuple} ${inclusive} (?, ?)`);
      values.push(through.value, through.id);
    }
    return [filters.join(" AND "), values];
  };
  return {
    key,
    scope: catalogScope(section, folderId),
    baseKey: JSON.stringify([
      section === "drive" || section === "trash" ? section : "all",
      folderId,
      "",
      "",
      "date",
    ]),
    section,
    sortName,
    page,
    throughPage,
    limit,
    after,
    offset,
    includeTotal: input.includeTotal !== false,
    conditions,
    count: [`SELECT COUNT(*) AS total FROM jr_files WHERE ${clause}`, params],
    cursor(row) {
      return { value: row[sort.key], id: row.id };
    },
    select({ after, through, limit, offset = 0, membership, resume }) {
      const [filter, values] = conditions(after, through);
      const sql = [`SELECT * FROM jr_files WHERE ${filter}`];
      if (resume) {
        sql.push(`AND ${sortTuple} ${sort.operator} (?, ?)`);
        values.push(resume.value, resume.id);
      }
      if (membership) {
        const segment = membership.length > 1 ? " AND segment = ?" : "";
        sql.push(
          `AND id IN (SELECT file_id FROM jr_catalog_members WHERE listing = ?${segment})`,
        );
        values.push(...membership);
      }
      sql.push(order, "LIMIT ?");
      values.push(limit);
      if (offset) {
        sql.push("OFFSET ?");
        values.push(offset);
      }
      return [sql.join(" "), values];
    },
  };
}
import { catalogScope } from "./catalog-journal.mjs";

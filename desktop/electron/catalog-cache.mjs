import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OperationQueue } from "./operation-queue.mjs";
import {
  changesTable,
  folderTreeScope,
  journalSchema,
  scopeFilter,
} from "./catalog-journal.mjs";

const checkInterval = 60_000;
const statsInterval = 5 * checkInterval;
const changePageSize = 200;
const segmentSize = 80;
const fileColumns = [
  "id",
  "library_id",
  "folder_id",
  "object_key",
  "name",
  "mime_type",
  "size_bytes",
  "favorite",
  "trashed_at",
  "tags",
  "adjustments",
  "captured_at",
  "created_at",
  "updated_at",
];
const folderColumns = ["id", "library_id", "parent_id", "name", "created_at"];
const unchanged = (a, b) => a.revision === b.revision && a.token === b.token;

export class CatalogCache {
  #queue = new OperationQueue();
  #prepared = false;
  #checks = new Map();
  #activeListing;
  #statsDirty = false;

  constructor(filename, cloud, libraryId, schema) {
    this.filename = filename;
    this.cloud = cloud;
    this.libraryId = libraryId;
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.local = new DatabaseSync(filename, {
      enableForeignKeyConstraints: false,
    });
    try {
      this.local.exec(schema);
      const columns = this.local.prepare("PRAGMA table_info(jr_files)").all();
      if (!columns.some(({ name }) => name === "captured_at"))
        this.local.exec("ALTER TABLE jr_files ADD COLUMN captured_at TEXT");
      this.local.exec(`
        CREATE TABLE IF NOT EXISTS jr_catalog_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jr_catalog_members (
          listing TEXT NOT NULL, segment INTEGER NOT NULL, file_id TEXT NOT NULL,
          PRIMARY KEY(listing, segment, file_id)
        ) WITHOUT ROWID;
      `);
      this.putState = this.local.prepare(
        "INSERT INTO jr_catalog_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      this.getState = this.local.prepare(
        "SELECT value FROM jr_catalog_state WHERE key = ?",
      );
      this.addMember = this.local.prepare(
        "INSERT OR IGNORE INTO jr_catalog_members VALUES (?, ?, ?)",
      );
      this.removeMember = this.local.prepare(
        "DELETE FROM jr_catalog_members WHERE listing = ? AND segment = ? AND file_id = ?",
      );
      this.putFile = this.#upsert("jr_files", fileColumns);
      this.removePreviousOwner = this.local.prepare(
        "DELETE FROM jr_files WHERE library_id = ? AND object_key = ? AND id <> ?",
      );
      this.putFolder = this.#upsert("jr_folders", folderColumns);
      this.deleteFolder = this.local.prepare(
        "DELETE FROM jr_folders WHERE id = ?",
      );
    } catch (error) {
      this.local.close();
      throw error;
    }
  }
  #upsert(table, columns) {
    return this.local.prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
       ON CONFLICT(id) DO UPDATE SET ${columns
         .slice(1)
         .map((column) => `${column} = excluded.${column}`)
         .join(", ")}`,
    );
  }
  #state(key) {
    return JSON.parse(this.getState.get(key)?.value ?? "null");
  }
  #setState(key, value) {
    this.putState.run(key, JSON.stringify(value));
  }
  #transaction(operation) {
    this.local.exec("BEGIN");
    try {
      operation();
      this.local.exec("COMMIT");
    } catch (error) {
      this.local.exec("ROLLBACK");
      throw error;
    }
  }
  async #prepare() {
    if (this.#prepared) return;
    const [installed] = await this.cloud.query(
      "SELECT 1 AS ok FROM sqlite_schema WHERE type = 'trigger' AND name = 'jr_scope_folders_delete'",
    );
    if (!installed)
      for (const statement of journalSchema) await this.cloud.query(statement);
    this.#prepared = true;
  }
  invalidate() {
    this.#checks.clear();
    this.#statsDirty = true;
  }
  async #head(scope, refresh = false) {
    const previous = this.#checks.get(scope);
    if (!refresh && previous && Date.now() < previous.expires)
      return previous.result;
    const result = (async () => {
      await this.#prepare();
      const [where, params] = scopeFilter(scope);
      const [row] = await this.cloud.query(
        `SELECT revision, token FROM ${changesTable} WHERE ${where} ORDER BY revision DESC LIMIT 1`,
        [this.libraryId, ...params],
      );
      return row ?? { revision: 0, token: "" };
    })();
    this.#checks.set(scope, { result, expires: Date.now() + checkInterval });
    return result;
  }
  async #changes(scope, position, head, table, filters, handle) {
    const [where, params] = scopeFilter(scope);
    const [filter, filterParams] = filters;
    let cursor = position.revision;
    for (;;) {
      const changes = await this.cloud.query(
        `WITH pending AS MATERIALIZED (
           SELECT revision, entity_id FROM ${changesTable}
           WHERE ${where} AND revision > ? AND revision <= ?
           ORDER BY revision LIMIT ?
         )
         SELECT pending.revision, pending.entity_id, ${table}.*
         FROM pending LEFT JOIN ${table} ON ${table}.id = pending.entity_id AND ${filter}
         ORDER BY pending.revision`,
        [
          this.libraryId,
          ...params,
          cursor,
          head.revision,
          changePageSize,
          ...filterParams,
        ],
      );
      this.#transaction(() => {
        for (const change of changes) handle(change);
      });
      if (changes.length < changePageSize) return;
      cursor = changes.at(-1).revision;
    }
  }
  #putMember(query, index, row) {
    this.removePreviousOwner.run(row.library_id, row.object_key, row.id);
    this.putFile.run(...fileColumns.map((column) => row[column] ?? null));
    this.addMember.run(query.key, index, row.id);
  }
  #readSegment(query, segments, index, limit) {
    const [sql, params] = query.select({
      after: segments[index - 1]?.through,
      through: segments[index].through,
      limit,
      membership: [query.key, index],
      resume: query.after,
    });
    return this.local.prepare(sql).all(...params);
  }
  #appendSegments(query, segments, fresh, complete, head) {
    let start = 0;
    do {
      const size = segments.length ? segmentSize : segmentSize + 1;
      const part = fresh.slice(start, start + size);
      const last = complete && start + part.length === fresh.length;
      const index = segments.length;
      segments.push({
        through: last ? null : query.cursor(part.at(-1)),
        complete: last,
        head,
      });
      for (const row of part) this.#putMember(query, index, row);
      start += part.length;
    } while (start < fresh.length);
  }
  #legacyRows(query, error) {
    const base = this.#state(`listing:${query.baseKey}`);
    const coverage = base?.complete
      ? base
      : this.#state(`listing:${query.key}`);
    if (!coverage) throw error;
    const [sql, params] = query.select({
      after: query.after,
      through: coverage.frontier,
      offset: query.offset,
      limit: query.limit + 1,
    });
    const rows = this.local.prepare(sql).all(...params);
    if (!coverage.complete && rows.length < query.limit) throw error;
    return { rows, hasMore: !coverage.complete || rows.length > query.limit };
  }
  list(query, fetchRows) {
    return this.#queue.run(async () => {
      const changedView = this.#activeListing !== query.key;
      this.#activeListing = query.key;
      const validation = await this.#head(query.scope, changedView).then(
        (head) => ({ head }),
        (error) => ({ error }),
      );
      const key = `ranges:${query.key}`;
      let segments = this.#state(key) ?? [];
      const readLimit = query.offset + query.limit + 1;
      const rows = [];
      let { head, error } = validation;
      if (error && !segments.length) return this.#legacyRows(query, error);
      if (head && !segments.length && query.baseKey !== query.key) {
        const base = this.#state(`ranges:${query.baseKey}`);
        if (
          base?.at(-1)?.complete &&
          base.every((part) => unchanged(head, part.head))
        ) {
          const [sql, params] = query.select({
            limit: -1,
            membership: [query.baseKey],
          });
          const matching = this.local.prepare(sql).all(...params);
          this.#transaction(() => {
            this.#appendSegments(query, segments, matching, true, head);
            this.#setState(key, segments);
          });
        }
      }
      for (
        let index = 0;
        index < segments.length && rows.length < readLimit;
        index++
      ) {
        const segment = segments[index];
        if (head && !unchanged(head, segment.head)) {
          if (head.revision <= segment.head.revision) {
            // A restore can move this scope backwards. Rebuild the visited prefix.
            this.#transaction(() => {
              this.local
                .prepare("DELETE FROM jr_catalog_members WHERE listing = ?")
                .run(query.key);
              this.#setState(key, []);
            });
            segments = [];
            rows.length = 0;
            break;
          }
          try {
            await this.#changes(
              query.scope,
              segment.head,
              head,
              "jr_files",
              query.conditions(segments[index - 1]?.through, segment.through),
              (row) => {
                if (row.id) this.#putMember(query, index, row);
                else this.removeMember.run(query.key, index, row.entity_id);
              },
            );
            segment.head = head;
            this.#setState(key, segments);
          } catch (cause) {
            head = undefined;
            error = cause;
          }
        }
        rows.push(
          ...this.#readSegment(query, segments, index, readLimit - rows.length),
        );
      }
      while (!segments.at(-1)?.complete && rows.length < readLimit) {
        if (error) {
          if (rows.length >= readLimit - 1) break;
          throw error;
        }
        const limit = Math.min(readLimit - rows.length, 401);
        const fresh = await fetchRows(
          ...query.select({ after: segments.at(-1)?.through, limit }),
        );
        const first = segments.length;
        this.#transaction(() => {
          this.#appendSegments(
            query,
            segments,
            fresh,
            fresh.length < limit,
            head,
          );
          this.#setState(key, segments);
        });
        for (
          let index = first;
          index < segments.length && rows.length < readLimit;
          index++
        )
          rows.push(
            ...this.#readSegment(
              query,
              segments,
              index,
              readLimit - rows.length,
            ),
          );
      }
      return {
        rows: rows.slice(query.offset),
        hasMore:
          rows.length >= readLimit || (!!error && !segments.at(-1)?.complete),
      };
    });
  }
  folders(fetchFolders) {
    return this.#queue.run(async () => {
      const position = this.#state("folder-tree");
      const head = await this.#head(folderTreeScope).catch((error) => {
        if (!position && !this.#state("folders")) throw error;
        return null;
      });
      if (head && (!position || !unchanged(head, position))) {
        if (!position || head.revision <= position.revision) {
          const rows = await fetchFolders();
          this.#transaction(() => {
            this.local.exec("DELETE FROM jr_folders");
            for (const row of rows)
              this.putFolder.run(...folderColumns.map((column) => row[column]));
          });
        } else {
          await this.#changes(
            folderTreeScope,
            position,
            head,
            "jr_folders",
            ["library_id = ?", [this.libraryId]],
            (row) => {
              if (row.id)
                this.putFolder.run(
                  ...folderColumns.map((column) => row[column]),
                );
              else this.deleteFolder.run(row.entity_id);
            },
          );
        }
        this.#setState("folder-tree", head);
      }
      return this.local
        .prepare(
          "SELECT * FROM jr_folders WHERE library_id = ? ORDER BY name COLLATE NOCASE",
        )
        .all(this.libraryId);
    });
  }
  stats(fetchStats) {
    return this.#queue.run(async () => {
      const snapshot = this.#state("stats");
      if (
        snapshot &&
        (!this.#statsDirty || Date.now() < snapshot.at + statsInterval)
      )
        return snapshot.value;
      try {
        this.#statsDirty = false;
        const value = await fetchStats();
        this.#setState("stats", { value, at: Date.now() });
        return value;
      } catch (error) {
        this.#statsDirty = true;
        if (!snapshot) throw error;
        return snapshot.value;
      }
    });
  }
  timelineBounds(kind, fetchBounds) {
    return this.#queue.run(async () => {
      const key =
        kind === "all"
          ? "capture-timeline-bounds"
          : `capture-timeline-bounds:${kind}`;
      const snapshot = this.#state(key);
      try {
        const head = await this.#head("active");
        if (snapshot && unchanged(head, snapshot.head)) return snapshot.bounds;
        const bounds = await fetchBounds();
        this.#setState(key, { head, bounds });
        return bounds;
      } catch (error) {
        if (snapshot) return snapshot.bounds;
        throw error;
      }
    });
  }
  close(clear = false) {
    this.local.close();
    if (clear) rmSync(this.filename, { force: true });
  }
}

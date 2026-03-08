import type Database from "better-sqlite3";

export interface SearchResult {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

export function searchMemory(
  db: Database.Database,
  query: string,
  maxResults: number = 6
): SearchResult[] {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];

  const stmt = db.prepare(`
    SELECT c.path, c.start_line, c.end_line,
           snippet(chunks_fts, 0, '>>>', '<<<', '...', 40) AS snippet
    FROM chunks_fts
    JOIN chunks c ON chunks_fts.rowid = c.id
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);

  return stmt.all(sanitized, maxResults) as SearchResult[];
}

export function indexFile(
  db: Database.Database,
  path: string,
  content: string,
  chunkSize: number = 20
): void {
  const lines = content.split("\n");
  const hash = simpleHash(content);

  const existing = db.prepare("SELECT hash FROM chunks WHERE path = ? LIMIT 1").get(path) as
    | { hash: string }
    | undefined;
  if (existing?.hash === hash) return;

  const del = db.prepare("DELETE FROM chunks WHERE path = ?");
  const ins = db.prepare(
    "INSERT INTO chunks (path, start_line, end_line, text, hash) VALUES (?, ?, ?, ?, ?)"
  );
  const ftsIns = db.prepare(
    "INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)"
  );

  const tx = db.transaction(() => {
    del.run(path);
    for (let i = 0; i < lines.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, lines.length);
      const text = lines.slice(i, end).join("\n");
      const result = ins.run(path, i + 1, end, text, hash);
      ftsIns.run(result.lastInsertRowid, text);
    }
  });

  tx();
}

function sanitizeFtsQuery(query: string): string {
  return query.replace(/[^\w\s]/g, " ").trim();
}

function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

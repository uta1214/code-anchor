import * as vscode from 'vscode';
import * as path from 'path';
import { BookmarkIconType, Bookmark, BookmarksData, FavoriteFile, ICON_TYPE_LABELS } from './types';

// ─────────────────────────────────────────────────────────────────────────
// 🔧 FIX(security): 以前は coreAnchorProvider.ts と extension.ts の両方に
// 同じロジック（isIconPathAllowed / loadBookmarks の読み込み等）が別々に実装されており、
// 片方だけ修正されると挙動が食い違う恐れがあった。セキュリティに関わる判定・サニタイズ処理は
// このファイルに集約し、両方から共通で利用する。
// ─────────────────────────────────────────────────────────────────────────

/**
 * core-anchor.icons.* はワークスペース単位の .vscode/settings.json でも上書き可能な設定のため、
 * 信頼されていない（Workspace Trust未許可の）ワークスペースを開いた場合、
 * ワークスペース外の任意パスをアイコンとして参照させない。
 */
export function isIconPathAllowed(absolutePath: string): boolean {
  if (vscode.workspace.isTrusted) {
    return true;
  }
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return false;
  }
  const normalized = path.normalize(absolutePath);
  return workspaceFolders.some(folder => {
    const root = path.normalize(folder.uri.fsPath);
    return normalized === root || normalized.startsWith(root + path.sep);
  });
}

/**
 * 指定した絶対パスが root ディレクトリ配下にあるかどうかを判定する。
 * Favorite の相対パスがワークスペース外を指す（パストラバーサル）場合の検出に使用する。
 */
export function isPathWithinRoot(root: string, target: string): boolean {
  const normalizedRoot = path.normalize(root);
  const normalizedTarget = path.normalize(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep);
}

const VALID_ICON_TYPES = new Set<string>(Object.keys(ICON_TYPE_LABELS));

/**
 * 🔧 FIX(security): bookmarks.json はワークスペース単位のファイルであり、共有リポジトリ経由で
 * 第三者が内容を仕込める（＝信頼できない入力）。手動編集やImport機能を通じて型が壊れたデータ
 * （例: line が数値でなく文字列）が混入すると、Webview側でその値をエスケープせずHTML属性値に
 * 埋め込んでいる箇所（bookmarks.js の編集フォーム）が悪用され、属性の外に任意のタグを注入
 * できてしまう。ディスクからの読み込み・Import機能の両方の入口で型を強制し、不正な値は除外する。
 */
export function sanitizeBookmarksData(raw: any): BookmarksData {
  const result: BookmarksData = {};
  if (!raw || typeof raw !== 'object') return result;

  for (const key of Object.keys(raw)) {
    // __proto__ 等の特殊キーによるプロトタイプ汚染を防ぐ
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;

    const marks = (raw as any)[key];
    if (!Array.isArray(marks)) continue;

    const sanitizedMarks: Bookmark[] = [];
    for (const m of marks) {
      if (!m || typeof m !== 'object') continue;
      const line = Number(m.line);
      if (!Number.isFinite(line) || line < 0) continue; // 不正な行番号は破棄

      const label = typeof m.label === 'string' ? m.label : '';
      const iconType: BookmarkIconType = VALID_ICON_TYPES.has(m.iconType) ? m.iconType : 'default';
      const bookmark: Bookmark = { line: Math.trunc(line), label, iconType };
      if (Number.isFinite(Number(m.order))) {
        bookmark.order = Number(m.order);
      }
      sanitizedMarks.push(bookmark);
    }
    result[key] = sanitizedMarks;
  }
  return result;
}

/**
 * 🔧 FIX(security): favorites.json / Import データについても同様に型を強制する。
 * キーそのもの（ファイルパス）に対しても危険なキー名を除外する。
 */
export function sanitizeFavoritesData(raw: any): { [key: string]: FavoriteFile } {
  const result: { [key: string]: FavoriteFile } = {};
  if (!raw || typeof raw !== 'object') return result;

  for (const key of Object.keys(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (typeof key !== 'string' || key.length === 0) continue;

    const f = (raw as any)[key];
    if (!f || typeof f !== 'object') continue;

    const favorite: FavoriteFile = {
      path: key,
      description: typeof f.description === 'string' ? f.description : '',
      isRelative: typeof f.isRelative === 'boolean' ? f.isRelative : true,
      virtualFolderId: (typeof f.virtualFolderId === 'string' || f.virtualFolderId === null)
        ? f.virtualFolderId
        : null,
    };
    if (Number.isFinite(Number(f.order))) {
      favorite.order = Number(f.order);
    }
    result[key] = favorite;
  }
  return result;
}

/**
 * 仮想フォルダIDを一意に生成する。タイムスタンプのみだと同一ミリ秒内に連続作成された場合に
 * 衝突しうるため、必ずランダムなサフィックスを付与する。
 */
export function generateVirtualFolderId(): string {
  return 'vf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

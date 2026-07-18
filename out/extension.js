"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const coreAnchorProvider_1 = require("./coreAnchorProvider");
const security_1 = require("./security");
const decorationTypes = new Map();
// ③ notifications.show 設定に従って情報通知を表示するヘルパー
// エラーメッセージ (showErrorMessage) は設定に関わらず常に表示する
function showInfo(message) {
    const config = vscode.workspace.getConfiguration('core-anchor');
    if (config.get('notifications.show', true)) {
        vscode.window.showInformationMessage(message);
    }
}
// 🔧 FIX: isIconPathAllowed は security.ts に共通化（coreAnchorProvider.ts との重複実装を解消）
// カスタムアイコンパスを取得する関数
function getIconPath(context, iconType) {
    const config = vscode.workspace.getConfiguration('core-anchor');
    let customPath = config.get(`icons.${iconType}`);
    if (customPath && customPath.trim() !== '') {
        customPath = customPath.trim().replace(/^["']|["']$/g, '');
        let absolutePath = customPath;
        if (!path.isAbsolute(customPath)) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                absolutePath = path.join(workspaceFolders[0].uri.fsPath, customPath);
            }
        }
        if (fs.existsSync(absolutePath) && (0, security_1.isIconPathAllowed)(absolutePath)) {
            return absolutePath;
        }
    }
    return context.asAbsolutePath(path.join('resources', `bookmark-${iconType}.png`));
}
// デコレーションタイプを更新する関数
function updateDecorationTypes(context, provider) {
    decorationTypes.forEach(decoration => decoration.dispose());
    decorationTypes.clear();
    const iconTypes = ['default', 'todo', 'bug', 'note', 'important', 'question', 'all'];
    iconTypes.forEach(iconType => {
        const iconPath = getIconPath(context, iconType);
        const decorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.file(iconPath),
            gutterIconSize: 'contain',
        });
        decorationTypes.set(iconType, decorationType);
    });
    provider.setDecorationTypes(decorationTypes);
    if (vscode.window.activeTextEditor) {
        provider.updateDecorations(vscode.window.activeTextEditor);
    }
}
// ブックマークファイルのパスを取得
function getBookmarksPath() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders)
        return '';
    const vscodeFolder = path.join(workspaceFolders[0].uri.fsPath, '.vscode');
    if (!fs.existsSync(vscodeFolder)) {
        fs.mkdirSync(vscodeFolder);
    }
    return path.join(vscodeFolder, 'bookmarks.json');
}
// 🔧 FIX(perf): onDidChangeTextDocument は「1文字編集するたび」に発火するため、
// 素朴に毎回 loadBookmarks()（同期read + JSON.parse）を呼ぶと、ブックマークが
// 存在しないファイルを編集している場合でも毎回ディスクI/Oが走ってしまい、
// Remote-SSH/WSL/ネットワークドライブ等ではタイピング遅延の原因になりうる。
// bookmarks.json の mtime をキャッシュし、ディスク上で実際に変化していない限り
// 再読み込み・再パースをスキップする。mtime方式なら coreAnchorProvider.ts 側が
// 保存した場合でも次回アクセス時に確実に検知できるため、二重実装でも整合性が保てる。
let bookmarksCache = null;
// ブックマークを読み込む
function loadBookmarks() {
    const bookmarksPath = getBookmarksPath();
    if (!bookmarksPath || !fs.existsSync(bookmarksPath)) {
        bookmarksCache = null;
        return {};
    }
    try {
        const stat = fs.statSync(bookmarksPath);
        if (bookmarksCache &&
            bookmarksCache.path === bookmarksPath &&
            bookmarksCache.mtimeMs === stat.mtimeMs) {
            return bookmarksCache.data;
        }
        const content = fs.readFileSync(bookmarksPath, 'utf-8');
        const parsed = JSON.parse(content);
        // Windows 環境で保存されたデータにバックスラッシュが混入している場合に備え、
        // すべてのキーをスラッシュ区切りに正規化する。
        // 🔧 FIX(security): あわせて、bookmarks.json は共有リポジトリ経由の信頼できない入力
        // でありうるため、型を強制する（sanitizeBookmarksData）。
        const normalized = {};
        for (const [key, value] of Object.entries(parsed)) {
            normalized[key.replace(/\\/g, '/')] = value;
        }
        const sanitized = (0, security_1.sanitizeBookmarksData)(normalized);
        bookmarksCache = { path: bookmarksPath, mtimeMs: stat.mtimeMs, data: sanitized };
        return sanitized;
    }
    catch (error) {
        console.error('Error loading bookmarks:', error);
        bookmarksCache = null;
        return {};
    }
}
// ブックマークを保存する
function saveBookmarks(bookmarks) {
    const bookmarksPath = getBookmarksPath();
    if (!bookmarksPath)
        return; // ワークスペースがない場合はスキップ
    try {
        fs.writeFileSync(bookmarksPath, JSON.stringify(bookmarks, null, 2));
        // 🔧 FIX(perf): 書き込み直後に mtime を取得してキャッシュも更新しておく。
        // こうすることで、保存した直後に loadBookmarks() が呼ばれても再読込を省略できる。
        const stat = fs.statSync(bookmarksPath);
        bookmarksCache = { path: bookmarksPath, mtimeMs: stat.mtimeMs, data: bookmarks };
    }
    catch (error) {
        console.error('Error saving bookmarks:', error);
        // 書き込みに失敗した場合、キャッシュとディスクの内容が食い違っている可能性があるため
        // キャッシュを破棄し、次回は必ずディスクから読み直す。
        bookmarksCache = null;
    }
}
const SCOPE_PICK_ITEMS = [
    { label: '$(star) Favorites only', value: 'favorites' },
    { label: '$(bookmark) Bookmarks only', value: 'bookmarks' },
    { label: '$(files) Both', value: 'both' },
];
// 🆕 Favorites / Bookmarks / 両方 をエクスポートする（統合版）
async function exportCoreAnchorData(provider) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('Core Anchor: No workspace folder is open');
        return;
    }
    const scopeChoice = await vscode.window.showQuickPick(SCOPE_PICK_ITEMS, {
        title: 'Export Core Anchor Data',
        placeHolder: 'What would you like to export?',
    });
    if (!scopeChoice)
        return;
    const scope = scopeChoice.value;
    const exportData = {
        version: '1.1',
        exportedAt: new Date().toISOString(),
    };
    if (scope === 'favorites' || scope === 'both') {
        exportData.favorites = provider.loadFavorites();
        exportData.favoritesMeta = provider.loadFavoritesMeta();
    }
    if (scope === 'bookmarks' || scope === 'both') {
        exportData.bookmarks = loadBookmarks();
        exportData.bookmarksMeta = provider.loadBookmarksMeta();
    }
    const defaultName = scope === 'favorites' ? 'core-anchor-favorites.json' :
        scope === 'bookmarks' ? 'core-anchor-bookmarks.json' :
            'core-anchor-data.json';
    // 🔧 FIX: 以前は fsPath を文字列結合してから vscode.Uri.file() で包んでいたが、
    // これだとリモート(WSL/SSH等)のスキームやauthority情報が失われ、
    // 「file:///home/user/...」という実在しないローカルパスのURIになってしまっていた。
    // vscode.Uri.joinPath はワークスペースURIのスキーム/authorityを正しく維持したまま
    // パスを連結できるため、こちらを使う。
    const defaultUri = vscode.Uri.joinPath(workspaceFolders[0].uri, defaultName);
    const uri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { 'JSON': ['json'] },
        title: 'Export Core Anchor Data',
    });
    if (!uri)
        return;
    // 🔧 FIX: Node.jsの fs はエクステンションホストが動作している側（Remote-SSH等では
    // リモートのLinux側）のファイルシステムしか扱えない。showSaveDialogが返すURIは
    // ローカル（クライアント側）のパスを指している場合があり、その場合 fs.writeFileSync は
    // ENOENTで失敗する。vscode.workspace.fs はURIのスキームに応じて適切なファイルシステムに
    // ディスパッチしてくれるため、常にこちらを使う。
    try {
        const bytes = Buffer.from(JSON.stringify(exportData, null, 2), 'utf-8');
        await vscode.workspace.fs.writeFile(uri, bytes);
        showInfo(`Core Anchor: Data exported to ${path.basename(uri.fsPath)}`);
    }
    catch (error) {
        vscode.window.showErrorMessage(`Core Anchor: Export failed — ${error}`);
    }
}
// 🆕 Favorites / Bookmarks / 両方 をインポートする（統合版・入り口）
// ファイルの中身を見て、Favorites/Bookmarksどちらのデータが含まれているかを自動判定する。
// 後方互換: 旧バージョン（bookmarksのみを含むエクスポート）もそのまま読み込める。
async function importCoreAnchorData(provider) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    // 🔧 FIX: exportCoreAnchorData と同じ形式（Uri.joinPath）の defaultUri を付与し、挙動を揃える。
    const defaultUri = workspaceFolders
        ? workspaceFolders[0].uri
        : undefined;
    // 🔧 FIX: VS Code の SimpleFileDialog はローカル表示の可否を「ファイル選択かフォルダ選択か」
    // 等の条件で内部的に出し分けている。canSelectFiles/canSelectFolders を明示することで、
    // exportCoreAnchorData（showSaveDialog、常にファイル選択扱い）と同じ判定になるようにする。
    const uris = await vscode.window.showOpenDialog({
        defaultUri,
        filters: { 'JSON': ['json'] },
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: 'Import Core Anchor Data',
    });
    if (!uris || uris.length === 0)
        return;
    let importData;
    try {
        // 🔧 FIX: エクスポート同様、リモート環境でも正しく読み込めるよう vscode.workspace.fs を使う
        const bytes = await vscode.workspace.fs.readFile(uris[0]);
        const content = Buffer.from(bytes).toString('utf-8');
        importData = JSON.parse(content);
    }
    catch {
        vscode.window.showErrorMessage('Core Anchor: Failed to read the file. Please check it is a valid JSON file.');
        return;
    }
    // 🔧 FIX(security): インポートファイルは外部から受け取る信頼できない入力のため、
    // 中身を使う前に型を強制し、__proto__ 等の危険なキーやbookmarksの不正な line 等を除去する。
    if (importData && typeof importData.bookmarks === 'object' && importData.bookmarks !== null) {
        importData.bookmarks = (0, security_1.sanitizeBookmarksData)(importData.bookmarks);
    }
    if (importData && typeof importData.favorites === 'object' && importData.favorites !== null) {
        importData.favorites = (0, security_1.sanitizeFavoritesData)(importData.favorites);
    }
    const hasBookmarks = typeof importData.bookmarks === 'object' && importData.bookmarks !== null &&
        typeof importData.bookmarksMeta === 'object' && importData.bookmarksMeta !== null;
    const hasFavorites = typeof importData.favorites === 'object' && importData.favorites !== null &&
        typeof importData.favoritesMeta === 'object' && importData.favoritesMeta !== null;
    if (!hasBookmarks && !hasFavorites) {
        vscode.window.showErrorMessage('Core Anchor: Invalid file format. This file does not appear to be a Core Anchor export.');
        return;
    }
    let scope;
    if (hasBookmarks && hasFavorites) {
        const scopeChoice = await vscode.window.showQuickPick(SCOPE_PICK_ITEMS, {
            title: 'Import Core Anchor Data',
            placeHolder: 'This file contains both Favorites and Bookmarks. What would you like to import?',
        });
        if (!scopeChoice)
            return;
        scope = scopeChoice.value;
    }
    else {
        scope = hasFavorites ? 'favorites' : 'bookmarks';
    }
    if (scope === 'bookmarks' || scope === 'both') {
        await importBookmarksData(provider, importData.bookmarks, importData.bookmarksMeta);
    }
    if (scope === 'favorites' || scope === 'both') {
        await importFavoritesData(provider, importData.favorites, importData.favoritesMeta);
    }
    provider.refresh();
}
// ブックマークのインポート処理（マージ/置き換え）
async function importBookmarksData(provider, importedBookmarks, importedMeta) {
    const choice = await vscode.window.showQuickPick([
        {
            label: '$(merge) Merge',
            description: 'Add bookmarks from import that do not exist locally (existing takes priority)',
            value: 'merge',
        },
        {
            label: '$(replace-all) Replace',
            description: 'Replace all existing bookmarks with imported data',
            value: 'replace',
        },
    ], {
        title: 'Import Bookmarks',
        placeHolder: 'How would you like to import bookmarks?',
    });
    if (!choice)
        return;
    if (choice.value === 'replace') {
        // 既存データを丸ごと置き換え
        saveBookmarks(importedBookmarks);
        provider.saveBookmarksMeta(importedMeta);
        showInfo('Core Anchor: Bookmarks replaced with imported data');
        return;
    }
    // ── Merge ────────────────────────────────────────────────────────────
    // 1. コンフリクト（同ファイル＋同行番号）を検出
    // 2. コンフリクトがあれば QuickPick (canPickMany) でユーザーに選択させる
    //    - チェックあり → インポート側で上書き
    //    - チェックなし → 既存を保持（デフォルト）
    // 3. コンフリクトなしのBMは自動でマージ
    const existing = loadBookmarks();
    const existingMeta = provider.loadBookmarksMeta();
    const conflictItems = [];
    for (const [filePath, importedBMs] of Object.entries(importedBookmarks)) {
        if (!Array.isArray(importedBMs))
            continue; // 不正なデータをスキップ
        if (!existing[filePath])
            continue;
        const existingLineMap = new Map(existing[filePath].map(bm => [bm.line, bm]));
        for (const importedBM of importedBMs) {
            const existingBM = existingLineMap.get(importedBM.line);
            if (!existingBM)
                continue;
            // 同じラベル・アイコンなら実質コンフリクトなし（スキップ）
            if (existingBM.label === importedBM.label &&
                existingBM.iconType === importedBM.iconType)
                continue;
            const fileName = filePath.split('/').pop() ?? filePath;
            const existingLabel = existingBM.label || '(no label)';
            const importedLabel = importedBM.label || '(no label)';
            const existingIcon = existingBM.iconType ? `[${existingBM.iconType}]` : '';
            const importedIcon = importedBM.iconType ? `[${importedBM.iconType}]` : '';
            conflictItems.push({
                label: `$(warning) ${fileName}  line ${importedBM.line + 1}`,
                description: `existing: ${existingIcon}${existingLabel}  →  import: ${importedIcon}${importedLabel}`,
                detail: filePath,
                picked: false, // デフォルトはチェックなし（既存を保持）
                filePath,
                line: importedBM.line,
            });
        }
    }
    // ── コンフリクトがある場合: QuickPick で選択 ─────────────────────
    // どの行をインポート側で上書きするかを Set で管理
    const overwriteKeys = new Set(); // `${filePath}:${line}`
    if (conflictItems.length > 0) {
        const selected = await vscode.window.showQuickPick(conflictItems, {
            canPickMany: true,
            title: `Import Bookmarks — ${conflictItems.length} conflict(s) found`,
            placeHolder: 'Check items to overwrite with imported version (unchecked = keep existing)',
        });
        // キャンセルされたら中断
        if (selected === undefined)
            return;
        for (const item of selected) {
            overwriteKeys.add(`${item.filePath}:${item.line}`);
        }
    }
    // ── マージ実行 ────────────────────────────────────────────────────
    const mergedBookmarks = { ...existing };
    for (const [filePath, importedBMs] of Object.entries(importedBookmarks)) {
        if (!Array.isArray(importedBMs))
            continue; // 不正なデータをスキップ
        if (!mergedBookmarks[filePath]) {
            // 既存にないファイル: インポートをそのまま追加
            mergedBookmarks[filePath] = importedBMs;
        }
        else {
            const existingLines = new Set(mergedBookmarks[filePath].map(bm => bm.line));
            for (const importedBM of importedBMs) {
                const key = `${filePath}:${importedBM.line}`;
                if (!existingLines.has(importedBM.line)) {
                    // 行番号が被らない → 追加
                    mergedBookmarks[filePath].push(importedBM);
                }
                else if (overwriteKeys.has(key)) {
                    // コンフリクトかつユーザーが上書きを選択 → 既存を置き換え
                    mergedBookmarks[filePath] = mergedBookmarks[filePath].map(bm => bm.line === importedBM.line ? importedBM : bm);
                }
                // それ以外（コンフリクトで既存保持を選択）→ 何もしない
            }
        }
    }
    // fileOrder: 既存順を維持しつつ新規ファイルを末尾に追加
    const mergedFileOrder = [...existingMeta.fileOrder];
    (importedMeta.fileOrder || []).forEach((f) => {
        if (!mergedFileOrder.includes(f))
            mergedFileOrder.push(f);
    });
    // bookmarkSortType: 既存優先（新規ファイル分のみ追加）
    const mergedSortType = {
        ...importedMeta.bookmarkSortType,
        ...existingMeta.bookmarkSortType,
    };
    const mergedMeta = {
        fileOrder: mergedFileOrder,
        bookmarkSortType: mergedSortType,
        globalSortType: existingMeta.globalSortType ?? importedMeta.globalSortType,
    };
    saveBookmarks(mergedBookmarks);
    provider.saveBookmarksMeta(mergedMeta);
    showInfo('Core Anchor: Bookmarks imported successfully');
}
// 🆕 Favoritesのインポート処理（マージ/置き換え）
// Favoritesはpathをキーにした単純なマップなので、コンフリクトは「既存優先でスキップ」という
// シンプルな方針にしている（Bookmarksのような行単位の詳細な競合解決UIは設けていない）。
// 仮想フォルダは「同名・同階層のフォルダがあれば再利用、無ければ新規作成してID振り直し」で
// エクスポート元とインポート先でフォルダIDがズレていても正しくマージされるようにする。
async function importFavoritesData(provider, importedFavorites, importedMeta) {
    const choice = await vscode.window.showQuickPick([
        {
            label: '$(merge) Merge',
            description: 'Add favorites/folders from import that do not exist locally (existing takes priority)',
            value: 'merge',
        },
        {
            label: '$(replace-all) Replace',
            description: 'Replace all existing favorites with imported data',
            value: 'replace',
        },
    ], {
        title: 'Import Favorites',
        placeHolder: 'How would you like to import favorites?',
    });
    if (!choice)
        return;
    if (choice.value === 'replace') {
        provider.saveFavorites(importedFavorites || {});
        provider.saveFavoritesMeta(importedMeta || { folderOrder: [], fileOrder: {}, virtualFolders: [] });
        showInfo('Core Anchor: Favorites replaced with imported data');
        return;
    }
    // ── Merge ────────────────────────────────────────────────────────────
    const existingFavorites = provider.loadFavorites();
    const existingMeta = provider.loadFavoritesMeta();
    const existingFolders = existingMeta.virtualFolders || [];
    const importedFolders = (importedMeta && importedMeta.virtualFolders) || [];
    // 仮想フォルダをマージ: 同名・同階層のフォルダは既存を再利用し、無ければ新規作成してIDを振り直す
    // 親フォルダを子より先に処理するため、階層の浅い順に並べ替える
    const depthOf = (folder) => {
        let depth = 0;
        let current = folder;
        const seen = new Set();
        while (current && current.parentId && !seen.has(current.id)) {
            seen.add(current.id);
            current = importedFolders.find(f => f.id === current.parentId);
            depth++;
        }
        return depth;
    };
    const sortedImportedFolders = [...importedFolders].sort((a, b) => depthOf(a) - depthOf(b));
    const idMap = new Map(); // インポート元ID -> インポート先ID
    const mergedFolders = [...existingFolders];
    let nextOrder = mergedFolders.length;
    sortedImportedFolders.forEach(folder => {
        const resolvedParentId = folder.parentId ? (idMap.get(folder.parentId) ?? null) : null;
        const existingMatch = mergedFolders.find(f => f.name === folder.name && (f.parentId ?? null) === resolvedParentId);
        if (existingMatch) {
            idMap.set(folder.id, existingMatch.id);
        }
        else {
            const newId = (0, security_1.generateVirtualFolderId)(); // 🔧 FIX: security.tsの共通関数に統一
            mergedFolders.push({
                id: newId,
                name: folder.name,
                order: nextOrder++,
                color: folder.color,
                parentId: resolvedParentId,
            });
            idMap.set(folder.id, newId);
        }
    });
    // Favoritesをマージ（既存優先。存在しないpathのみ追加。virtualFolderIdはidMapで付け替え）
    const mergedFavorites = { ...existingFavorites };
    let addedCount = 0;
    Object.entries(importedFavorites || {}).forEach(([filePath, data]) => {
        if (mergedFavorites[filePath])
            return; // 既存優先でスキップ
        const remappedFolderId = data.virtualFolderId ? (idMap.get(data.virtualFolderId) ?? null) : null;
        mergedFavorites[filePath] = { ...data, virtualFolderId: remappedFolderId };
        addedCount++;
    });
    const mergedMeta = {
        folderOrder: existingMeta.folderOrder,
        fileOrder: existingMeta.fileOrder,
        virtualFolders: mergedFolders,
    };
    provider.saveFavorites(mergedFavorites);
    provider.saveFavoritesMeta(mergedMeta);
    showInfo(`Core Anchor: Imported ${addedCount} new favorite(s)`);
}
function activate(context) {
    const provider = new coreAnchorProvider_1.CoreAnchorProvider(context);
    updateDecorationTypes(context, provider);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('core-anchor.mainView', provider));
    context.subscriptions.push(vscode.commands.registerCommand('core-anchor.refresh', () => {
        provider.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('core-anchor.addBookmark', async () => {
        await provider.addBookmarkFromCommand();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('core-anchor.addFavorite', async () => {
        await provider.addFavoriteFromCommand();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('core-anchor.moveBookmarkUp', async () => {
        await provider.moveBookmarkUp();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('core-anchor.moveBookmarkDown', async () => {
        await provider.moveBookmarkDown();
    }));
    // デバッグ用：手動でdecorationを更新
    context.subscriptions.push(vscode.commands.registerCommand('core-anchor.refreshDecorations', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            provider.updateDecorations(editor);
            showInfo('Core Anchor: Decorations refreshed');
        }
        else {
            vscode.window.showWarningMessage('Core Anchor: No active editor');
        }
    }));
    // ショートカットでカーソル行のブックマーク情報を表示
    context.subscriptions.push(vscode.commands.registerCommand('core-anchor.showBookmarkAtCursor', () => {
        provider.showBookmarkAtCursor();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('core-anchor.goToPreviousBookmark', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
        const bookmarks = loadBookmarks();
        const fileBookmarks = bookmarks[relativePath] || [];
        if (fileBookmarks.length === 0) {
            showInfo('No bookmarks in this file');
            return;
        }
        const currentLine = editor.selection.active.line;
        // ② navigation.wrap 設定を読み取る
        const navConfig = vscode.workspace.getConfiguration('core-anchor');
        const wrap = navConfig.get('bookmarks.navigation.wrap', true);
        // 現在行より前のブックマークを探す（降順にソート）
        const previousBookmarks = fileBookmarks
            .filter(bm => bm.line < currentLine)
            .sort((a, b) => b.line - a.line);
        let targetBookmark;
        if (previousBookmarks.length > 0) {
            targetBookmark = previousBookmarks[0];
        }
        else if (wrap) {
            // 前のブックマークがない場合は最後のブックマークにループ
            targetBookmark = [...fileBookmarks].sort((a, b) => b.line - a.line)[0];
        }
        else {
            showInfo('Already at the first bookmark');
            return;
        }
        // ブックマークにジャンプ
        const position = new vscode.Position(targetBookmark.line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        // ハイライト
        provider.highlightBookmark(relativePath, targetBookmark.line);
        showInfo(`Bookmark: ${targetBookmark.label || 'Line ' + (targetBookmark.line + 1)}`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('core-anchor.goToNextBookmark', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
        const bookmarks = loadBookmarks();
        const fileBookmarks = bookmarks[relativePath] || [];
        if (fileBookmarks.length === 0) {
            showInfo('No bookmarks in this file');
            return;
        }
        const currentLine = editor.selection.active.line;
        // ② navigation.wrap 設定を読み取る
        const navConfig = vscode.workspace.getConfiguration('core-anchor');
        const wrap = navConfig.get('bookmarks.navigation.wrap', true);
        // 現在行より後のブックマークを探す（昇順にソート）
        const nextBookmarks = fileBookmarks
            .filter(bm => bm.line > currentLine)
            .sort((a, b) => a.line - b.line);
        let targetBookmark;
        if (nextBookmarks.length > 0) {
            targetBookmark = nextBookmarks[0];
        }
        else if (wrap) {
            // 次のブックマークがない場合は最初のブックマークにループ
            targetBookmark = [...fileBookmarks].sort((a, b) => a.line - b.line)[0];
        }
        else {
            showInfo('Already at the last bookmark');
            return;
        }
        // ブックマークにジャンプ
        const position = new vscode.Position(targetBookmark.line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        // ハイライト
        provider.highlightBookmark(relativePath, targetBookmark.line);
        showInfo(`Bookmark: ${targetBookmark.label || 'Line ' + (targetBookmark.line + 1)}`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('core-anchor.exportBookmarks', async () => {
        await exportCoreAnchorData(provider);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('core-anchor.importBookmarks', async () => {
        await importCoreAnchorData(provider);
    }));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
            // アクティブなエディタだけでなく、同じドキュメントを開いている
            // 全エディタ（分割ペインを含む）を更新する
            vscode.window.visibleTextEditors
                .filter(e => e.document === editor.document)
                .forEach(e => provider.updateDecorations(e));
        }
    }));
    // 🔧 FIX: SSH Remote 環境などで接続が一瞬切れて復帰した際、
    // onDidChangeActiveTextEditor や onDidChangeTextDocument のどちらも発火しないまま
    // エディタ側のガター装飾（setDecorationsで設定した内容）だけが失われるケースがある。
    // ウィンドウのフォーカス状態や可視エディタの集合が変化したタイミングでも
    // 現在表示中の全エディタに対して装飾を再適用し、確実に復元されるようにする。
    context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
            vscode.window.visibleTextEditors.forEach(e => provider.updateDecorations(e));
        }
    }));
    context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors((editors) => {
        editors.forEach(e => provider.updateDecorations(e));
    }));
    // ドキュメント変更時にブックマークの行番号を調整
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
        // activeTextEditor に依存せず event.document を直接使う。
        // これにより分割ペインでアクティブでない側でも正しく処理できる。
        const relativePath = vscode.workspace.asRelativePath(event.document.uri);
        const bookmarks = loadBookmarks();
        if (!bookmarks[relativePath] || bookmarks[relativePath].length === 0)
            return;
        let needsUpdate = false;
        // -----------------------------------------------------------------------
        // 各 contentChange を「下から上の順」で独立処理する。
        //
        // 【なぜ下から上か】
        //   下の変更を先に処理してもブックマーク配列の行番号は上の変更に
        //   無関係に更新できる。逆順にすることで「複数 change の合算」が
        //   不要になり、Find & Replace / マルチカーソル / Git revert hunk など
        //   複数 change が同時に届くケースを正確に処理できる。
        // -----------------------------------------------------------------------
        const sortedChanges = [...event.contentChanges].sort((a, b) => b.range.start.line - a.range.start.line);
        for (const change of sortedChanges) {
            const startLine = change.range.start.line;
            const endLine = change.range.end.line;
            const startChar = change.range.start.character;
            const endChar = change.range.end.character;
            const newText = change.text;
            const newLineCount = newText.split('\n').length - 1;
            const deletedLineCount = endLine - startLine;
            const lineDiff = newLineCount - deletedLineCount;
            // ── ① 複数行削除がある場合: 削除範囲内のブックマークを処理 ──────────
            if (deletedLineCount > 0) {
                // endChar === 0 のとき endLine は「次の行の先頭」を指しているだけで
                // endLine 自体の内容は残る。実際に消える最終行は endLine - 1。
                const effectiveEndLine = endChar === 0 ? endLine - 1 : endLine;
                // 行結合 (Backspace / Delete) の判定:
                //   Backspace: start:(N-1, len>0) end:(N, 0)
                //   Delete:    start:(N, len>0)   end:(N+1, 0)
                //   どちらも startChar > 0 かつ endChar === 0 かつ newText === '' の形。
                const isLineJoin = deletedLineCount === 1 && endChar === 0 && startChar > 0 && newText === '';
                if (isLineJoin) {
                    // ── 行結合の場合 ─────────────────────────────────────────────────
                    // endLine の内容は startLine に吸収される。
                    // endLine にBMがある場合、startLine にBMがあればラベルをマージし、
                    // なければ startLine に移動する（黙って消さない）。
                    const bmOnEnd = bookmarks[relativePath].find(bm => bm.line === endLine);
                    const bmOnStart = bookmarks[relativePath].find(bm => bm.line === startLine);
                    if (bmOnEnd) {
                        if (bmOnStart) {
                            // 両行にBMがある → startLine のラベルに endLine のラベルを追記
                            if (bmOnEnd.label) {
                                bmOnStart.label = bmOnStart.label
                                    ? `${bmOnStart.label} | ${bmOnEnd.label}`
                                    : bmOnEnd.label;
                            }
                            // endLine のBMは削除（startLine に統合済み）
                            bookmarks[relativePath] = bookmarks[relativePath].filter(bm => bm.line !== endLine);
                        }
                        else {
                            // startLine にBMがない → endLine のBMを startLine に移動
                            bmOnEnd.line = startLine;
                        }
                        needsUpdate = true;
                    }
                }
                else {
                    // ── 通常の複数行削除 ─────────────────────────────────────────────
                    //
                    // rescue が必要なケース:
                    //   (A) endChar > 0:
                    //       endLine の末尾 (char endChar 以降) が startLine に合流する。
                    //       例) start:(9,0) end:(10,4) text="    " (auto-indent付きCtrl+Z)
                    //           → BM@10 は新しい line 9 に移動すべき
                    //   (B) startChar > 0 かつ endChar === 0:
                    //       endLine の全内容が startLine に吸収される。
                    //       例) start:(5,3) end:(8,0) text="" (複数行選択Delete)
                    //           → BM@8 は line 5 に移動すべき
                    //
                    // 【旧実装の問題】rescue を「startChar > 0 のとき」に限定していたため、
                    //   ケース(A)で startChar=0 のとき rescue がスキップされ、
                    //   BM が削除範囲として除去されるバグがあった。
                    let rescuedToStartLine = false;
                    // ケース (A): endChar > 0
                    if (endChar > 0) {
                        const rescueLine = effectiveEndLine; // endChar > 0 なら effectiveEndLine = endLine
                        const bmOnRescue = bookmarks[relativePath].find(bm => bm.line === rescueLine);
                        const bmOnStart = bookmarks[relativePath].find(bm => bm.line === startLine);
                        if (bmOnRescue) {
                            if (bmOnStart) {
                                // 両行にBMがある → ラベルをマージ（bmOnRescue は下のfilterで除去）
                                if (bmOnRescue.label) {
                                    bmOnStart.label = bmOnStart.label
                                        ? `${bmOnStart.label} | ${bmOnRescue.label}`
                                        : bmOnRescue.label;
                                }
                            }
                            else {
                                // startLine にBMがない → rescueLine のBMを startLine に移動
                                bmOnRescue.line = startLine;
                                rescuedToStartLine = true;
                            }
                            needsUpdate = true;
                        }
                    }
                    // ケース (B): startChar > 0 かつ endChar === 0
                    if (startChar > 0 && endChar === 0) {
                        const rescueLine = endLine;
                        const bmOnRescue = bookmarks[relativePath].find(bm => bm.line === rescueLine);
                        const bmOnStart = bookmarks[relativePath].find(bm => bm.line === startLine);
                        if (bmOnRescue) {
                            if (bmOnStart) {
                                if (bmOnRescue.label) {
                                    bmOnStart.label = bmOnStart.label
                                        ? `${bmOnStart.label} | ${bmOnRescue.label}`
                                        : bmOnRescue.label;
                                }
                            }
                            else {
                                bmOnRescue.line = startLine;
                                rescuedToStartLine = true;
                            }
                            needsUpdate = true;
                        }
                    }
                    const before = bookmarks[relativePath].length;
                    bookmarks[relativePath] = bookmarks[relativePath].filter(bm => {
                        if (bm.line < startLine)
                            return true; // 変更より上: 保持
                        // startLine を保持する条件:
                        //   startChar > 0 → startLine 先頭が残っている
                        //   rescuedToStartLine → endLine のBMをここに移動済み
                        if (bm.line === startLine && (startChar > 0 || rescuedToStartLine))
                            return true;
                        // rescue 済みの元の位置を除去
                        if (startChar > 0 && endChar === 0 && bm.line === endLine)
                            return false;
                        if (endChar > 0 && bm.line === effectiveEndLine)
                            return false;
                        if (bm.line > effectiveEndLine)
                            return true; // 変更より下: 保持（後でシフト）
                        return false; // 削除範囲内: 除去
                    });
                    if (bookmarks[relativePath].length !== before) {
                        needsUpdate = true;
                    }
                }
            }
            // ── ② 行数が変化した場合: 変更より下にあるブックマークをシフト ────
            if (lineDiff !== 0) {
                const effectiveEndForShift = deletedLineCount > 0
                    ? (endChar === 0 ? endLine - 1 : endLine)
                    : startLine;
                // 行の先頭 (startChar === 0) に純粋に行が挿入された場合:
                //   その行自体のブックマークも下に追い出す必要がある。
                //   例) 5行目の先頭で Enter → 5行目のブックマークは6行目へ。
                const pushCurrentLine = startChar === 0 && deletedLineCount === 0;
                for (const bm of bookmarks[relativePath]) {
                    if (pushCurrentLine && bm.line === startLine) {
                        bm.line += lineDiff;
                        needsUpdate = true;
                    }
                    else if (bm.line > effectiveEndForShift) {
                        bm.line += lineDiff;
                        needsUpdate = true;
                    }
                }
            }
        }
        if (needsUpdate) {
            saveBookmarks(bookmarks);
            // 同じドキュメントを開いている全エディタを更新（分割ペイン対応）
            vscode.window.visibleTextEditors
                .filter(e => e.document === event.document)
                .forEach(e => provider.updateDecorations(e));
            provider.refresh();
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('core-anchor.icons')) {
            updateDecorationTypes(context, provider);
            provider.refresh();
        }
        if (e.affectsConfiguration('core-anchor.ui.theme')) {
            provider.reloadWebview();
        }
        if (e.affectsConfiguration('core-anchor.ui.showFavorites') ||
            e.affectsConfiguration('core-anchor.ui.showBookmarks')) {
            provider.reloadWebview();
        }
    }));
    // 初期化完了後、既に開いているエディタにデコレーションを適用
    // decorationTypesが設定された後に実行されることを保証
    if (vscode.window.activeTextEditor) {
        provider.updateDecorations(vscode.window.activeTextEditor);
    }
}
function deactivate() {
    decorationTypes.forEach(decoration => decoration.dispose());
    decorationTypes.clear();
}
//# sourceMappingURL=extension.js.map
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CoreAnchorProvider } from './coreAnchorProvider';
import { BookmarkIconType, BookmarksData, BookmarksMeta } from './types';

const decorationTypes: Map<BookmarkIconType, vscode.TextEditorDecorationType> = new Map();

// ③ notifications.show 設定に従って情報通知を表示するヘルパー
// エラーメッセージ (showErrorMessage) は設定に関わらず常に表示する
function showInfo(message: string): void {
  const config = vscode.workspace.getConfiguration('core-anchor');
  if (config.get<boolean>('notifications.show', true)) {
    vscode.window.showInformationMessage(message);
  }
}

// 🔧 FIX(security): core-anchor.icons.* はワークスペース単位の .vscode/settings.json でも
// 上書き可能な設定のため、信頼されていない（Workspace Trust未許可の）ワークスペースを開いた場合、
// ワークスペース外の任意パスをアイコンとして参照させない。
function isIconPathAllowed(absolutePath: string): boolean {
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

// カスタムアイコンパスを取得する関数
function getIconPath(context: vscode.ExtensionContext, iconType: BookmarkIconType): string {
  const config = vscode.workspace.getConfiguration('core-anchor');
  let customPath = config.get<string>(`icons.${iconType}`);

  if (customPath && customPath.trim() !== '') {
    customPath = customPath.trim().replace(/^["']|["']$/g, '');
    
    let absolutePath = customPath;
    
    if (!path.isAbsolute(customPath)) {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        absolutePath = path.join(workspaceFolders[0].uri.fsPath, customPath);
      }
    }
    
    if (fs.existsSync(absolutePath) && isIconPathAllowed(absolutePath)) {
      return absolutePath;
    }
  }
  
  return context.asAbsolutePath(path.join('resources', `bookmark-${iconType}.png`));
}

// デコレーションタイプを更新する関数
function updateDecorationTypes(context: vscode.ExtensionContext, provider: CoreAnchorProvider) {
  
  
  decorationTypes.forEach(decoration => decoration.dispose());
  decorationTypes.clear();
  
  const iconTypes: BookmarkIconType[] = ['default', 'todo', 'bug', 'note', 'important', 'question', 'all'];
  
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
function getBookmarksPath(): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return '';
  
  const vscodeFolder = path.join(workspaceFolders[0].uri.fsPath, '.vscode');
  if (!fs.existsSync(vscodeFolder)) {
    fs.mkdirSync(vscodeFolder);
  }
  
  return path.join(vscodeFolder, 'bookmarks.json');
}

// ブックマークを読み込む
function loadBookmarks(): BookmarksData {
  const bookmarksPath = getBookmarksPath();
  if (!fs.existsSync(bookmarksPath)) return {};
  
  try {
    const content = fs.readFileSync(bookmarksPath, 'utf-8');
    const raw: BookmarksData = JSON.parse(content);

    // Windows 環境で保存されたデータにバックスラッシュが混入している場合に備え、
    // すべてのキーをスラッシュ区切りに正規化する。
    const normalized: BookmarksData = {};
    for (const [key, value] of Object.entries(raw)) {
      normalized[key.replace(/\\/g, '/')] = value;
    }
    return normalized;
  } catch (error) {
    console.error('Error loading bookmarks:', error);
    return {};
  }
}

// ブックマークを保存する
function saveBookmarks(bookmarks: BookmarksData) {
  const bookmarksPath = getBookmarksPath();
  if (!bookmarksPath) return; // ワークスペースがない場合はスキップ
  try {
    fs.writeFileSync(bookmarksPath, JSON.stringify(bookmarks, null, 2));
  } catch (error) {
    console.error('Error saving bookmarks:', error);
  }
}

// ブックマークをエクスポートする
async function exportBookmarks(provider: CoreAnchorProvider): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showErrorMessage('Core Anchor: No workspace folder is open');
    return;
  }

  const bookmarks = loadBookmarks();
  const bookmarksMeta = provider.loadBookmarksMeta();

  const exportData = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    bookmarks,
    bookmarksMeta,
  };

  const defaultUri = vscode.Uri.file(
    path.join(workspaceFolders[0].uri.fsPath, 'core-anchor-bookmarks.json')
  );

  const uri = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { 'JSON': ['json'] },
    title: 'Export Core Anchor Bookmarks',
  });

  if (!uri) return;

  try {
    fs.writeFileSync(uri.fsPath, JSON.stringify(exportData, null, 2));
    showInfo(`Core Anchor: Bookmarks exported to ${path.basename(uri.fsPath)}`);
  } catch (error) {
    vscode.window.showErrorMessage(`Core Anchor: Export failed — ${error}`);
  }
}

// ブックマークをインポートする
async function importBookmarks(provider: CoreAnchorProvider): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    filters: { 'JSON': ['json'] },
    canSelectMany: false,
    title: 'Import Core Anchor Bookmarks',
  });

  if (!uris || uris.length === 0) return;

  let importData: any;
  try {
    const content = fs.readFileSync(uris[0].fsPath, 'utf-8');
    importData = JSON.parse(content);
  } catch {
    vscode.window.showErrorMessage(
      'Core Anchor: Failed to read the file. Please check it is a valid JSON file.'
    );
    return;
  }

  // バリデーション: version / bookmarks / bookmarksMeta が揃っているか確認
  if (
    typeof importData.version !== 'string' ||
    typeof importData.bookmarks !== 'object' || importData.bookmarks === null ||
    typeof importData.bookmarksMeta !== 'object' || importData.bookmarksMeta === null
  ) {
    vscode.window.showErrorMessage(
      'Core Anchor: Invalid file format. This file does not appear to be a Core Anchor export.'
    );
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
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
    ],
    {
      title: 'Import Core Anchor Bookmarks',
      placeHolder: 'How would you like to import?',
    }
  );

  if (!choice) return;

  if (choice.value === 'replace') {
    // 既存データを丸ごと置き換え
    saveBookmarks(importData.bookmarks as BookmarksData);
    provider.saveBookmarksMeta(importData.bookmarksMeta as BookmarksMeta);
  } else {
    // ── Merge ────────────────────────────────────────────────────────────
    // 1. コンフリクト（同ファイル＋同行番号）を検出
    // 2. コンフリクトがあれば QuickPick (canPickMany) でユーザーに選択させる
    //    - チェックあり → インポート側で上書き
    //    - チェックなし → 既存を保持（デフォルト）
    // 3. コンフリクトなしのBMは自動でマージ
    const existing = loadBookmarks();
    const existingMeta = provider.loadBookmarksMeta();

    // ── コンフリクト検出 ──────────────────────────────────────────────
    interface ConflictItem extends vscode.QuickPickItem {
      filePath: string;
      line: number;
    }
    const conflictItems: ConflictItem[] = [];

    for (const [filePath, importedBMs] of Object.entries(importData.bookmarks as BookmarksData)) {
      if (!Array.isArray(importedBMs)) continue; // 不正なデータをスキップ
      if (!existing[filePath]) continue;
      const existingLineMap = new Map(existing[filePath].map(bm => [bm.line, bm]));
      for (const importedBM of importedBMs) {
        const existingBM = existingLineMap.get(importedBM.line);
        if (!existingBM) continue;

        // 同じラベル・アイコンなら実質コンフリクトなし（スキップ）
        if (existingBM.label === importedBM.label &&
            existingBM.iconType === importedBM.iconType) continue;

        const fileName = filePath.split('/').pop() ?? filePath;
        const existingLabel  = existingBM.label  || '(no label)';
        const importedLabel  = importedBM.label  || '(no label)';
        const existingIcon   = existingBM.iconType  ? `[${existingBM.iconType}]`  : '';
        const importedIcon   = importedBM.iconType  ? `[${importedBM.iconType}]`  : '';

        conflictItems.push({
          label:       `$(warning) ${fileName}  line ${importedBM.line + 1}`,
          description: `existing: ${existingIcon}${existingLabel}  →  import: ${importedIcon}${importedLabel}`,
          detail:      filePath,
          picked:      false,   // デフォルトはチェックなし（既存を保持）
          filePath,
          line: importedBM.line,
        });
      }
    }

    // ── コンフリクトがある場合: QuickPick で選択 ─────────────────────
    // どの行をインポート側で上書きするかを Set で管理
    const overwriteKeys = new Set<string>(); // `${filePath}:${line}`

    if (conflictItems.length > 0) {
      const selected = await vscode.window.showQuickPick(conflictItems, {
        canPickMany: true,
        title: `Import Bookmarks — ${conflictItems.length} conflict(s) found`,
        placeHolder: 'Check items to overwrite with imported version (unchecked = keep existing)',
      });

      // キャンセルされたら中断
      if (selected === undefined) return;

      for (const item of selected) {
        overwriteKeys.add(`${item.filePath}:${item.line}`);
      }
    }

    // ── マージ実行 ────────────────────────────────────────────────────
    const mergedBookmarks: BookmarksData = { ...existing };

    for (const [filePath, importedBMs] of Object.entries(importData.bookmarks as BookmarksData)) {
      if (!Array.isArray(importedBMs)) continue; // 不正なデータをスキップ
      if (!mergedBookmarks[filePath]) {
        // 既存にないファイル: インポートをそのまま追加
        mergedBookmarks[filePath] = importedBMs;
      } else {
        const existingLines = new Set(mergedBookmarks[filePath].map(bm => bm.line));
        for (const importedBM of importedBMs) {
          const key = `${filePath}:${importedBM.line}`;
          if (!existingLines.has(importedBM.line)) {
            // 行番号が被らない → 追加
            mergedBookmarks[filePath].push(importedBM);
          } else if (overwriteKeys.has(key)) {
            // コンフリクトかつユーザーが上書きを選択 → 既存を置き換え
            mergedBookmarks[filePath] = mergedBookmarks[filePath].map(bm =>
              bm.line === importedBM.line ? importedBM : bm
            );
          }
          // それ以外（コンフリクトで既存保持を選択）→ 何もしない
        }
      }
    }

    // fileOrder: 既存順を維持しつつ新規ファイルを末尾に追加
    const mergedFileOrder = [...existingMeta.fileOrder];
    ((importData.bookmarksMeta as BookmarksMeta).fileOrder || []).forEach((f: string) => {
      if (!mergedFileOrder.includes(f)) mergedFileOrder.push(f);
    });

    // bookmarkSortType: 既存優先（新規ファイル分のみ追加）
    const mergedSortType = {
      ...(importData.bookmarksMeta as BookmarksMeta).bookmarkSortType,
      ...existingMeta.bookmarkSortType,
    };

    const mergedMeta: BookmarksMeta = {
      fileOrder: mergedFileOrder,
      bookmarkSortType: mergedSortType,
      globalSortType: existingMeta.globalSortType ??
        (importData.bookmarksMeta as BookmarksMeta).globalSortType,
    };

    saveBookmarks(mergedBookmarks);
    provider.saveBookmarksMeta(mergedMeta);
  }

  provider.refresh();
  showInfo('Core Anchor: Bookmarks imported successfully');
}

export function activate(context: vscode.ExtensionContext) {
  
  
  const provider = new CoreAnchorProvider(context);

  updateDecorationTypes(context, provider);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('core-anchor.mainView', provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('core-anchor.refresh', () => {
      
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('core-anchor.addBookmark', async () => {
      
      await provider.addBookmarkFromCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('core-anchor.addFavorite', async () => {
      
      await provider.addFavoriteFromCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('core-anchor.moveBookmarkUp', async () => {
      
      await provider.moveBookmarkUp();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('core-anchor.moveBookmarkDown', async () => {
      
      await provider.moveBookmarkDown();
    })
  );

  // デバッグ用：手動でdecorationを更新
  context.subscriptions.push(
    vscode.commands.registerCommand('core-anchor.refreshDecorations', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        provider.updateDecorations(editor);
        showInfo('Core Anchor: Decorations refreshed');
      } else {
        vscode.window.showWarningMessage('Core Anchor: No active editor');
      }
    })
  );

  // ショートカットでカーソル行のブックマーク情報を表示
  context.subscriptions.push(
    vscode.commands.registerCommand('core-anchor.showBookmarkAtCursor', () => {
      provider.showBookmarkAtCursor();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('core-anchor.goToPreviousBookmark', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      
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
      const wrap = navConfig.get<boolean>('bookmarks.navigation.wrap', true);

      // 現在行より前のブックマークを探す（降順にソート）
      const previousBookmarks = fileBookmarks
        .filter(bm => bm.line < currentLine)
        .sort((a, b) => b.line - a.line);
      
      let targetBookmark;
      if (previousBookmarks.length > 0) {
        targetBookmark = previousBookmarks[0];
      } else if (wrap) {
        // 前のブックマークがない場合は最後のブックマークにループ
        targetBookmark = [...fileBookmarks].sort((a, b) => b.line - a.line)[0];
      } else {
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
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('core-anchor.goToNextBookmark', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      
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
      const wrap = navConfig.get<boolean>('bookmarks.navigation.wrap', true);
      
      // 現在行より後のブックマークを探す（昇順にソート）
      const nextBookmarks = fileBookmarks
        .filter(bm => bm.line > currentLine)
        .sort((a, b) => a.line - b.line);
      
      let targetBookmark;
      if (nextBookmarks.length > 0) {
        targetBookmark = nextBookmarks[0];
      } else if (wrap) {
        // 次のブックマークがない場合は最初のブックマークにループ
        targetBookmark = [...fileBookmarks].sort((a, b) => a.line - b.line)[0];
      } else {
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
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('core-anchor.exportBookmarks', async () => {
      await exportBookmarks(provider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('core-anchor.importBookmarks', async () => {
      await importBookmarks(provider);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        // アクティブなエディタだけでなく、同じドキュメントを開いている
        // 全エディタ（分割ペインを含む）を更新する
        vscode.window.visibleTextEditors
          .filter(e => e.document === editor.document)
          .forEach(e => provider.updateDecorations(e));
      }
    })
  );

  // 🔧 FIX: SSH Remote 環境などで接続が一瞬切れて復帰した際、
  // onDidChangeActiveTextEditor や onDidChangeTextDocument のどちらも発火しないまま
  // エディタ側のガター装飾（setDecorationsで設定した内容）だけが失われるケースがある。
  // ウィンドウのフォーカス状態や可視エディタの集合が変化したタイミングでも
  // 現在表示中の全エディタに対して装飾を再適用し、確実に復元されるようにする。
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        vscode.window.visibleTextEditors.forEach(e => provider.updateDecorations(e));
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      editors.forEach(e => provider.updateDecorations(e));
    })
  );

  // ドキュメント変更時にブックマークの行番号を調整
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      // activeTextEditor に依存せず event.document を直接使う。
      // これにより分割ペインでアクティブでない側でも正しく処理できる。
      const relativePath = vscode.workspace.asRelativePath(event.document.uri);
      const bookmarks = loadBookmarks();
      
      if (!bookmarks[relativePath] || bookmarks[relativePath].length === 0) return;
      
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
      const sortedChanges = [...event.contentChanges].sort(
        (a, b) => b.range.start.line - a.range.start.line
      );

      for (const change of sortedChanges) {
        const startLine       = change.range.start.line;
        const endLine         = change.range.end.line;
        const startChar       = change.range.start.character;
        const endChar         = change.range.end.character;
        const newText         = change.text;
        const newLineCount    = newText.split('\n').length - 1;
        const deletedLineCount = endLine - startLine;
        const lineDiff        = newLineCount - deletedLineCount;

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
            const bmOnEnd   = bookmarks[relativePath].find(bm => bm.line === endLine);
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
                bookmarks[relativePath] = bookmarks[relativePath].filter(
                  bm => bm.line !== endLine
                );
              } else {
                // startLine にBMがない → endLine のBMを startLine に移動
                bmOnEnd.line = startLine;
              }
              needsUpdate = true;
            }
          } else {
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
              const bmOnStart  = bookmarks[relativePath].find(bm => bm.line === startLine);

              if (bmOnRescue) {
                if (bmOnStart) {
                  // 両行にBMがある → ラベルをマージ（bmOnRescue は下のfilterで除去）
                  if (bmOnRescue.label) {
                    bmOnStart.label = bmOnStart.label
                      ? `${bmOnStart.label} | ${bmOnRescue.label}`
                      : bmOnRescue.label;
                  }
                } else {
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
              const bmOnStart  = bookmarks[relativePath].find(bm => bm.line === startLine);

              if (bmOnRescue) {
                if (bmOnStart) {
                  if (bmOnRescue.label) {
                    bmOnStart.label = bmOnStart.label
                      ? `${bmOnStart.label} | ${bmOnRescue.label}`
                      : bmOnRescue.label;
                  }
                } else {
                  bmOnRescue.line = startLine;
                  rescuedToStartLine = true;
                }
                needsUpdate = true;
              }
            }

            const before = bookmarks[relativePath].length;
            bookmarks[relativePath] = bookmarks[relativePath].filter(bm => {
              if (bm.line < startLine) return true; // 変更より上: 保持
              // startLine を保持する条件:
              //   startChar > 0 → startLine 先頭が残っている
              //   rescuedToStartLine → endLine のBMをここに移動済み
              if (bm.line === startLine && (startChar > 0 || rescuedToStartLine)) return true;
              // rescue 済みの元の位置を除去
              if (startChar > 0 && endChar === 0 && bm.line === endLine) return false;
              if (endChar > 0 && bm.line === effectiveEndLine) return false;
              if (bm.line > effectiveEndLine) return true; // 変更より下: 保持（後でシフト）
              return false;                                // 削除範囲内: 除去
            });
            if (bookmarks[relativePath].length !== before) {
              needsUpdate = true;
            }
          }
        }

        // ── ② 行数が変化した場合: 変更より下にあるブックマークをシフト ────
        if (lineDiff !== 0) {
          const effectiveEndForShift =
            deletedLineCount > 0
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
            } else if (bm.line > effectiveEndForShift) {
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
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
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
    })
  );

  // 初期化完了後、既に開いているエディタにデコレーションを適用
  // decorationTypesが設定された後に実行されることを保証
  if (vscode.window.activeTextEditor) {
    provider.updateDecorations(vscode.window.activeTextEditor);
  }
}

export function deactivate() {
  
  decorationTypes.forEach(decoration => decoration.dispose());
  decorationTypes.clear();
}
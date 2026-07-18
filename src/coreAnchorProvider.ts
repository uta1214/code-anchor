import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { FavoriteFile, Bookmark, BookmarksData, BookmarkIconType, ICON_TYPE_LABELS, FavoriteMode, SortType, FavoritesMeta, BookmarksMeta, VirtualFolder } from './types';
import { getHtmlContent } from './webview/index';
import { isIconPathAllowed, isPathWithinRoot, sanitizeBookmarksData, sanitizeFavoritesData, generateVirtualFolderId } from './security';

export class CoreAnchorProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private decorationTypes?: Map<BookmarkIconType, vscode.TextEditorDecorationType>;
  private favoriteMode: FavoriteMode = 'global';
  private nextFavoriteOrder: number = 0;
  private nextBookmarkOrder: number = 0;

  constructor(private context: vscode.ExtensionContext) {
    this.favoriteMode = this.context.workspaceState.get('favoriteMode', 'global');
  }

  setDecorationTypes(decorationTypes: Map<BookmarkIconType, vscode.TextEditorDecorationType>) {
    this.decorationTypes = decorationTypes;
  }

  // ③ notifications.show 設定に従って情報通知を表示するヘルパー
  // エラーメッセージ (showErrorMessage) は設定に関わらず常に表示する
  private showInfo(message: string): void {
    const config = vscode.workspace.getConfiguration('core-anchor');
    if (config.get<boolean>('notifications.show', true)) {
      vscode.window.showInformationMessage(message);
    }
  }

  // 🆕 Undo可能な操作向けの通知。誤操作からの復旧手段のため、
  // notifications.show設定に関わらず常に表示する（Undoボタン付き）。
  // 直前1件のみ復元可能なシンプルな実装。
  private undoToken: symbol | undefined;
  private showUndoableInfo(message: string, restore: () => void): void {
    const token = Symbol();
    this.undoToken = token;
    vscode.window.showInformationMessage(message, 'Undo').then(selection => {
      if (selection === 'Undo') {
        if (this.undoToken === token) {
          restore();
        } else {
          // 🔧 FIX: 別の操作が既に行われ、この通知のUndoはもう有効ではない。
          // 何も起きないまま終わるとユーザーが「押したのに反応しない」と混乱するため、理由を伝える。
          vscode.window.showWarningMessage('Core Anchor: This action can no longer be undone (a newer change was made since).');
        }
      }
      if (this.undoToken === token) {
        this.undoToken = undefined;
      }
    });
  }

  reloadWebview() {
    if (this._view) {
      try {
        this._view.webview.html = this.getHtmlContent(this._view.webview);
        this.sendIconPaths(this._view);
        this.sendFavoriteMode();
        const folderDepth = this.context.workspaceState.get('folderDepth', 1);
        this._view.webview.postMessage({
          command: 'setFolderDepth',
          depth: folderDepth
        });
        
        // セクションの表示設定を送信（追加）
        const config = vscode.workspace.getConfiguration('core-anchor');
        const showFavorites = config.get<boolean>('ui.showFavorites', true);
        const showBookmarks = config.get<boolean>('ui.showBookmarks', true);
        this._view.webview.postMessage({
          command: 'setSectionVisibility',
          showFavorites: showFavorites,
          showBookmarks: showBookmarks
        });
        
        this.refresh();
      } catch (error) {
        console.error('Error reloading webview:', error);
      }
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    const customIconDirs = this.getCustomIconDirectories();
    
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'resources')),
        ...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri),
        ...customIconDirs
      ]
    };

    try {
      webviewView.webview.html = this.getHtmlContent(webviewView.webview);
    } catch (error) {
      console.error('Error setting webview HTML:', error);
    }

    this.sendIconPaths(webviewView);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'addFavorite':
          await this.addFavorite(message.path, message.description, message.isRelative, message.virtualFolderId);
          break;
        case 'quickAddCurrentFile':
          await this.quickAddCurrentFile();
          break;
        case 'addFileWithContext':
          await this.addFileWithContext();
          break;
        case 'createVirtualFolder':
          await this.createVirtualFolder(message.name, message.parentId);
          break;
        case 'createSubfolder':
          await this.createSubfolderWithUI(message.parentId, message.parentName);
          break;
        case 'renameVirtualFolder':
          if (message.newName) {
            await this.renameVirtualFolder(message.id, message.newName);
          } else {
            await this.renameVirtualFolderWithUI(message.id, message.currentName);
          }
          break;
        case 'deleteVirtualFolder':
          await this.deleteVirtualFolderWithConfirm(message.id, message.folderName);
          break;
        case 'changeFolderColor':
          if (message.color) {
            await this.changeFolderColor(message.id, message.color);
          } else {
            await this.changeFolderColorWithUI(message.id);
          }
          break;
        case 'moveFileToFolder':
          await this.moveFileToFolder(message.filePath, message.targetFolderId);
          break;
        case 'moveFilesToFolder':
          await this.moveFilesToFolder(message.filePaths, message.targetFolderId);
          break;
        case 'moveFolderToFolder':
          await this.moveFolderToFolder(message.folderId, message.targetParentId);
          break;
        case 'reorderFilesInFolder':
          await this.reorderFilesInFolder(message.folderId, message.draggedFile, message.targetFile, message.position);
          break;
        case 'reorderFolders':
          await this.reorderFolders(message.draggedFolderId, message.targetFolderId, message.position, message.parentId);
          break;
        case 'editFavorite':
          await this.editFavorite(message.oldPath, message.newPath, message.description);
          break;
        case 'removeFavorite':
          await this.removeFavorite(message.path);
          break;
        case 'bulkRemoveFavorites':
          await this.bulkRemoveFavorites(message.paths);
          break;
        case 'bulkMoveFavoritesToFolder':
          await this.bulkMoveFavoritesToFolder(message.paths);
          break;
        case 'openFile':
          await this.openFile(message.path, message.openToSide);
          break;
        case 'addBookmarkWithContext':
          await this.addBookmarkWithContext();
          break;
        case 'addBookmarkManual':
          await this.addBookmarkManual(message.filePath, message.line, message.label, message.iconType);
          break;
        case 'editBookmark':
          await this.editBookmark(message.filePath, message.oldLine, message.newLine, message.label, message.iconType);
          break;
        case 'removeBookmark':
          await this.removeBookmark(message.filePath, message.line);
          break;
        case 'bulkRemoveBookmarks':
          await this.bulkRemoveBookmarks(message.items);
          break;
        case 'jumpToBookmark':
          await this.jumpToBookmark(message.filePath, message.line, message.openToSide);
          break;
        case 'switchFavoriteMode':
          await this.switchFavoriteMode(message.mode);
          break;
        case 'setFolderDepth':
          await this.setFolderDepth(message.depth);
          break;
        case 'sortFavoriteFolders':
          await this.sortFavoriteFolders(message.sortType);
          break;
        case 'sortFavoriteFiles':
          await this.sortFavoriteFiles(message.folderPath, message.sortType);
          break;
        case 'sortBookmarkFiles':
          await this.sortBookmarkFiles(message.sortType);
          break;
        case 'sortBookmarks':
          await this.sortBookmarks(message.sortType);
          break;
        case 'reorderFavoriteFolders':
          await this.reorderFavoriteFolders(message.folders);
          break;
        case 'reorderFavoriteFiles':
          await this.reorderFavoriteFiles(message.folderPath, message.files);
          break;
        case 'reorderBookmarkFiles':
          await this.reorderBookmarkFiles(message.files);
          break;
        case 'reorderBookmarks':
          await this.reorderBookmarks(message.filePath, message.bookmarks);
          break;
        case 'refresh':
          this.refresh();
          break;
        case 'ready':
          this.sendIconPaths(webviewView);
          this.sendFavoriteMode();
          const folderDepth = this.context.workspaceState.get('folderDepth', 1);
          webviewView.webview.postMessage({
            command: 'setFolderDepth',
            depth: folderDepth
          });
          // セクションの表示設定を送信
          const config = vscode.workspace.getConfiguration('core-anchor');
          const showFavorites = config.get<boolean>('ui.showFavorites', true);
          const showBookmarks = config.get<boolean>('ui.showBookmarks', true);
          webviewView.webview.postMessage({
            command: 'setSectionVisibility',
            showFavorites: showFavorites,
            showBookmarks: showBookmarks
          });
          this.refresh();
          break;
      }
    });

    // パネルが再び表示されたタイミングで必ず再描画する。
    // SSH 接続環境では別パネルへの切り替えや接続の揺れにより
    // resolveWebviewView が再呼び出しされないまま webview が空になる場合があるため、
    // visible になるたびに refresh() を呼ぶことで確実にデータを復元する。
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendIconPaths(webviewView);
        this.sendFavoriteMode();
        // folderDepth は workspaceState で管理されているため、
        // webview が再表示されたタイミングで必ず再送する。
        const folderDepth = this.context.workspaceState.get('folderDepth', 1);
        webviewView.webview.postMessage({
          command: 'setFolderDepth',
          depth: folderDepth
        });
        const config = vscode.workspace.getConfiguration('core-anchor');
        const showFavorites = config.get<boolean>('ui.showFavorites', true);
        const showBookmarks = config.get<boolean>('ui.showBookmarks', true);
        webviewView.webview.postMessage({
          command: 'setSectionVisibility',
          showFavorites: showFavorites,
          showBookmarks: showBookmarks
        });
        this.refresh();
      }
    });
    
    this.refresh();
  }

  // 🔧 FIX: isIconPathAllowed は security.ts に共通化（extension.ts との重複実装を解消）

  private getCustomIconDirectories(): vscode.Uri[] {
    const dirs = new Set<string>();
    const config = vscode.workspace.getConfiguration('core-anchor');
    const iconTypes: BookmarkIconType[] = ['default', 'todo', 'bug', 'note', 'important', 'question', 'all'];
    
    iconTypes.forEach(iconType => {
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
          const dir = path.dirname(absolutePath);
          dirs.add(dir);
        }
      }
    });
    
    return Array.from(dirs).map(dir => vscode.Uri.file(dir));
  }

  private getMaterialIconName(filePath: string): string {
    const fileName = filePath.split('/').pop() || '';
    const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : '';
    const lowerFileName = fileName.toLowerCase();

    // 特殊なファイル名のマッピング
    const specialFiles: { [key: string]: string } = {
      'package.json': 'nodejs',
      'package-lock.json': 'nodejs',
      'tsconfig.json': 'tsconfig',
      'webpack.config.js': 'webpack',
      'dockerfile': 'docker',
      'docker-compose.yml': 'docker',
      'makefile': 'settings',
      '.gitignore': 'git',
      '.gitattributes': 'git',
      'readme.md': 'markdown',
      'readme': 'info',
      'license': 'certificate',
      '.env': 'tune',
      '.env.local': 'tune',
      '.eslintrc': 'eslint',
      '.prettierrc': 'prettier',
    };

    for (const [key, icon] of Object.entries(specialFiles)) {
      if (lowerFileName === key || lowerFileName.startsWith(key + '.')) {
        return icon;
      }
    }

    // 拡張子のマッピング
    const extensionMap: { [key: string]: string } = {
      // JavaScript/TypeScript
      'js': 'javascript',
      'jsx': 'react',
      'ts': 'typescript',
      'tsx': 'react_ts',
      'mjs': 'javascript',
      'cjs': 'javascript',
      
      // C/C++
      'c': 'c',
      'h': 'h',
      'cpp': 'cpp',
      'cc': 'cpp',
      'cxx': 'cpp',
      'hpp': 'cpp',
      'hxx': 'cpp',
      
      // Python
      'py': 'python',
      'pyc': 'python',
      'pyd': 'python',
      'pyw': 'python',
      
      // Java
      'java': 'java',
      'class': 'java',
      'jar': 'java',
      
      // Web
      'html': 'html',
      'htm': 'html',
      'css': 'css',
      'scss': 'sass',
      'sass': 'sass',
      'less': 'less',
      
      // PHP
      'php': 'php',
      
      // Go
      'go': 'go',
      
      // Rust
      'rs': 'rust',
      
      // Ruby
      'rb': 'ruby',
      
      // Shell
      'sh': 'shell',
      'bash': 'shell',
      'zsh': 'shell',
      'fish': 'shell',
      
      // Data/Config
      'json': 'json',
      'yaml': 'yaml',
      'yml': 'yaml',
      'toml': 'toml',
      'xml': 'xml',
      'ini': 'settings',
      'conf': 'settings',
      'config': 'settings',
      
      // Markdown/Docs
      'md': 'markdown',
      'txt': 'document',
      
      // SQL
      'sql': 'database',
      
      // Other
      'proto': 'proto',
      'graphql': 'graphql',
      'gql': 'graphql',
      'vue': 'vue',
      'svelte': 'svelte',
      'swift': 'swift',
      'kt': 'kotlin',
      'scala': 'scala',
      'r': 'r',
      'dart': 'dart',
      'lua': 'lua',
      'perl': 'perl',
      'pl': 'perl',
    };

    if (extension && extensionMap[extension]) {
      return extensionMap[extension];
    }

    return 'file';
  }

  private sendIconPaths(webviewView: vscode.WebviewView) {
    const iconTypes: BookmarkIconType[] = ['default', 'todo', 'bug', 'note', 'important', 'question', 'all'];
    const iconPaths: { [key: string]: string } = {};
    
    iconTypes.forEach(iconType => {
      const iconPath = this.getIconPath(iconType);
      try {
        const webviewUri = webviewView.webview.asWebviewUri(vscode.Uri.file(iconPath));
        iconPaths[iconType] = webviewUri.toString();
      } catch (error) {
        console.error(`Error converting icon path for ${iconType}:`, error);
        const defaultPath = this.context.asAbsolutePath(path.join('resources', `bookmark-${iconType}.png`));
        const webviewUri = webviewView.webview.asWebviewUri(vscode.Uri.file(defaultPath));
        iconPaths[iconType] = webviewUri.toString();
      }
    });
    
    webviewView.webview.postMessage({
      command: 'setIconPaths',
      paths: iconPaths
    });
  }

  private sendFavoriteMode() {
    if (this._view) {
      this._view.webview.postMessage({
        command: 'setFavoriteMode',
        mode: this.favoriteMode
      });
    }
  }

  // Global Favoritesのパスを取得
  private getGlobalFavoritesPath(): string {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, '.vscode');
    
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    const newPath = path.join(configDir, 'core-anchor-favorites.json');
    return newPath;
  }

  // Local Favoritesのパスを取得
  private getLocalFavoritesPath(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return '';

    const vscodeFolder = path.join(workspaceFolders[0].uri.fsPath, '.vscode');
    if (!fs.existsSync(vscodeFolder)) {
      fs.mkdirSync(vscodeFolder);
    }

    return path.join(vscodeFolder, 'favorites.json');
  }

  // Favorites Metaのパスを取得
  private getFavoritesMetaPath(): string {
    if (this.favoriteMode === 'global') {
      const homeDir = os.homedir();
      const configDir = path.join(homeDir, '.vscode');
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      const newMetaPath = path.join(configDir, 'core-anchor-favorites-meta.json');
      return newMetaPath;
    } else {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) return '';
      const vscodeFolder = path.join(workspaceFolders[0].uri.fsPath, '.vscode');
      if (!fs.existsSync(vscodeFolder)) {
        fs.mkdirSync(vscodeFolder);
      }
      return path.join(vscodeFolder, 'favorites-meta.json');
    }
  }

  // Bookmarks Metaのパスを取得
  public getBookmarksMetaPath(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return '';
    const vscodeFolder = path.join(workspaceFolders[0].uri.fsPath, '.vscode');
    if (!fs.existsSync(vscodeFolder)) {
      fs.mkdirSync(vscodeFolder);
    }
    return path.join(vscodeFolder, 'bookmarks-meta.json');
  }

  // 現在のモードに応じたFavoritesパスを取得
  private getCurrentFavoritesPath(): string {
    return this.favoriteMode === 'global' 
      ? this.getGlobalFavoritesPath() 
      : this.getLocalFavoritesPath();
  }

  // Favoritesを読み込む
  public loadFavorites(): { [key: string]: FavoriteFile } {
    const favoritesPath = this.getCurrentFavoritesPath();
    
    if (!favoritesPath || !fs.existsSync(favoritesPath)) {
      return {};
    }

    try {
      const content = fs.readFileSync(favoritesPath, 'utf-8');
      // 🔧 FIX(security): favorites.json も bookmarks.json 同様、ワークスペース単位で
      // 共有されうる信頼できない入力のため、読み込み時に型を強制する。
      const favorites = sanitizeFavoritesData(JSON.parse(content));
      
      // orderを初期化
      let maxOrder = 0;
      Object.values(favorites).forEach((fav: any) => {
        if (fav.order !== undefined && fav.order > maxOrder) {
          maxOrder = fav.order;
        }
      });
      this.nextFavoriteOrder = maxOrder + 1;
      
      return favorites;
    } catch (error) {
      console.error('Error loading favorites:', error);
      return {};
    }
  }

  // Favorites Metaを読み込む
  public loadFavoritesMeta(): FavoritesMeta {
    const metaPath = this.getFavoritesMetaPath();
    
    if (!metaPath || !fs.existsSync(metaPath)) {
      return { folderOrder: [], fileOrder: {}, virtualFolders: [] };
    }

    try {
      const content = fs.readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(content);
      // 既存のデータにvirtualFoldersがない場合は追加
      if (!meta.virtualFolders) {
        meta.virtualFolders = [];
      }
      return meta;
    } catch (error) {
      console.error('Error loading favorites meta:', error);
      return { folderOrder: [], fileOrder: {}, virtualFolders: [] };
    }
  }

  // Bookmarks Metaを読み込む
  public loadBookmarksMeta(): BookmarksMeta {
    const metaPath = this.getBookmarksMetaPath();
    
    if (!metaPath || !fs.existsSync(metaPath)) {
      return { fileOrder: [], bookmarkSortType: {} };
    }

    try {
      const content = fs.readFileSync(metaPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error('Error loading bookmarks meta:', error);
      return { fileOrder: [], bookmarkSortType: {} };
    }
  }

  // Favoritesを保存する
  public saveFavorites(favorites: { [key: string]: FavoriteFile }) {
    const favoritesPath = this.getCurrentFavoritesPath();
    
    if (!favoritesPath) {
      vscode.window.showErrorMessage('No workspace folder is open');
      return;
    }

    try {
      fs.writeFileSync(favoritesPath, JSON.stringify(favorites, null, 2));
    } catch (error) {
      console.error('Error saving favorites:', error);
      vscode.window.showErrorMessage('Failed to save favorites');
    }
  }

  // Favorites Metaを保存
  public saveFavoritesMeta(meta: FavoritesMeta) {
    const metaPath = this.getFavoritesMetaPath();
    
    if (!metaPath) {
      return;
    }

    try {
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } catch (error) {
      console.error('Error saving favorites meta:', error);
    }
  }

  // Bookmarks Metaを保存
  public saveBookmarksMeta(meta: BookmarksMeta) {
    const metaPath = this.getBookmarksMetaPath();
    
    if (!metaPath) {
      return;
    }

    try {
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } catch (error) {
      console.error('Error saving bookmarks meta:', error);
    }
  }

  // モード切り替え
  private async switchFavoriteMode(mode: FavoriteMode) {
    this.favoriteMode = mode;
    await this.context.workspaceState.update('favoriteMode', mode);
    this.sendFavoriteMode();
    this.refresh();
    this.showInfo(`Switched to ${mode} favorites`);
  }

  // フォルダの深さをセット
  private async setFolderDepth(depth: number) {
    await this.context.workspaceState.update('folderDepth', depth);
    if (this._view) {
      this._view.webview.postMessage({
        command: 'setFolderDepth',
        depth: depth
      });
    }
  }

  // Favoriteフォルダをソート
  private async sortFavoriteFolders(sortType: SortType) {
    const favorites = this.loadFavorites();
    const meta = this.loadFavoritesMeta();
    
    const folderMap = new Map<string, string[]>();
    Object.keys(favorites).forEach(filePath => {
      const parts = filePath.split('/');
      const folderPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
      if (!folderMap.has(folderPath)) {
        folderMap.set(folderPath, []);
      }
    });
    
    let folders = Array.from(folderMap.keys());
    
    if (sortType === 'name') {
      folders.sort((a, b) => a.localeCompare(b));
    } else if (sortType === 'order') {
      // 追加順（現在の順序を保持）
      folders = folders;
    }
    
    meta.folderOrder = folders;
    this.saveFavoritesMeta(meta);
    this.refresh();
    this.showInfo('Folders sorted');
  }

  // Favoriteファイル（フォルダ内）をソート
  private async sortFavoriteFiles(folderPath: string, sortType: SortType) {
    const favorites = this.loadFavorites();
    const meta = this.loadFavoritesMeta();
    
    const filesInFolder = Object.entries(favorites)
      .filter(([filePath]) => {
        const parts = filePath.split('/');
        const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
        return folder === folderPath;
      })
      .map(([filePath, data]) => ({ filePath, data }));
    
    if (sortType === 'name') {
      filesInFolder.sort((a, b) => {
        const nameA = a.filePath.split('/').pop() || '';
        const nameB = b.filePath.split('/').pop() || '';
        return nameA.localeCompare(nameB);
      });
    } else if (sortType === 'order') {
      filesInFolder.sort((a, b) => (a.data.order || 0) - (b.data.order || 0));
    }
    
    meta.fileOrder[folderPath] = filesInFolder.map(f => f.filePath);
    this.saveFavoritesMeta(meta);
    this.refresh();
    this.showInfo('Files sorted');
  }

  // Bookmarkファイルをソート
  private async sortBookmarkFiles(sortType: SortType) {
    const bookmarks = this.loadBookmarks();
    const meta = this.loadBookmarksMeta();
    
    let files = Object.keys(bookmarks);
    
    if (sortType === 'name') {
      files.sort((a, b) => a.localeCompare(b));
    } else if (sortType === 'order') {
      // 追加順（現在の順序を保持）
      files = files;
    }
    
    meta.fileOrder = files;
    this.saveBookmarksMeta(meta);
    this.refresh();
    this.showInfo('Bookmark files sorted');
  }

  // Bookmarks（ファイル内）をソート
  private async sortBookmarks(sortType: SortType) {
    const bookmarks = this.loadBookmarks();
    const meta = this.loadBookmarksMeta();
    
    // 全ファイルのブックマークを一括ソート
    Object.keys(bookmarks).forEach(filePath => {
      if (sortType === 'line') {
        bookmarks[filePath].sort((a, b) => a.line - b.line);
      } else if (sortType === 'order') {
        bookmarks[filePath].sort((a, b) => (a.order || 0) - (b.order || 0));
      }
    });
    
    meta.globalSortType = sortType;
    this.saveBookmarks(bookmarks);
    this.saveBookmarksMeta(meta);
    this.refresh();
  }

  // Favoriteフォルダを並び替え（ドラッグ&ドロップ）
  private async reorderFavoriteFolders(folders: string[]) {
    const meta = this.loadFavoritesMeta();
    meta.folderOrder = folders;
    this.saveFavoritesMeta(meta);
    this.refresh();
  }

  // Favoriteファイルを並び替え（ドラッグ&ドロップ）
  private async reorderFavoriteFiles(folderPath: string, files: string[]) {
    const meta = this.loadFavoritesMeta();
    meta.fileOrder[folderPath] = files;
    this.saveFavoritesMeta(meta);
    this.refresh();
  }

  // Bookmarkファイルを並び替え（ドラッグ&ドロップ）
  private async reorderBookmarkFiles(files: string[]) {
    const meta = this.loadBookmarksMeta();
    meta.fileOrder = files;
    this.saveBookmarksMeta(meta);
    this.refresh();
  }

  // Bookmarksを並び替え（ドラッグ&ドロップ）
  private async reorderBookmarks(filePath: string, bookmarkLines: number[]) {
    const bookmarks = this.loadBookmarks();
    
    if (!bookmarks[filePath]) return;
    
    // 行番号の順序でブックマークを並び替え
    const reordered: Bookmark[] = [];
    bookmarkLines.forEach(line => {
      const bookmark = bookmarks[filePath].find(b => b.line === line);
      if (bookmark) {
        reordered.push(bookmark);
      }
    });
    
    bookmarks[filePath] = reordered;
    this.saveBookmarks(bookmarks);
    this.refresh();
  }

  private async addFavorite(filePath: string, description: string, isRelative: boolean = true, virtualFolderId: string | null = null) {
    if (!filePath.trim()) {
      vscode.window.showErrorMessage('File path is required');
      return;
    }

    const favorites = this.loadFavorites();
    favorites[filePath] = { 
      path: filePath, 
      description,
      order: this.nextFavoriteOrder++,
      isRelative: isRelative,
      virtualFolderId: virtualFolderId
    };
    this.saveFavorites(favorites);

    this.refresh();
    this.showInfo(`Added "${filePath}" to favorites`);
  }

  // Quick Add: 現在のファイルをフォルダ選択して追加
  private async quickAddCurrentFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor');
      return;
    }

    // ワークスペース自体が開いているか確認（ファイルがワークスペース外でもOK）
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder is open');
      return;
    }

    // ファイルがワークスペース内なら相対パス、外なら絶対パスを使用
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const filePath = workspaceFolder
      ? vscode.workspace.asRelativePath(editor.document.uri)
      : editor.document.uri.fsPath;
    const isRelative = !!workspaceFolder;

    // 既に登録されているか確認
    const favorites = this.loadFavorites();
    if (favorites[filePath]) {
      this.showInfo(`"${filePath}" is already in favorites`);
      return;
    }

    // フォルダ選択QuickPick
    const meta = this.loadFavoritesMeta();
    const virtualFolders = meta.virtualFolders || [];
    
    const folderItems: vscode.QuickPickItem[] = [
      {
        label: '$(inbox) Uncategorized',
        description: ''
      }
    ];
    
    folderItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    
    folderItems.push({
      label: '$(add) Create New Folder',
      description: ''
    });
    
    if (virtualFolders.length > 0) {
      folderItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      
      virtualFolders.forEach(folder => {
        folderItems.push({
          label: `$(folder) ${folder.name}`,
          description: ''
        });
      });
    }
    
    const selectedFolder = await vscode.window.showQuickPick(folderItems, {
      placeHolder: 'Select a folder (or press Escape to cancel)',
      title: 'Quick Add to Favorites'
    });
    
    // キャンセルされた場合は追加しない
    if (!selectedFolder) {
      return;
    }
    
    let virtualFolderId: string | null = null;
    
    // Uncategorizedを選択
    if (selectedFolder.label === '$(inbox) Uncategorized') {
      virtualFolderId = null;
    }
    // 新規フォルダ作成
    else if (selectedFolder.label === '$(add) Create New Folder') {
      const folderName = await vscode.window.showInputBox({
        prompt: 'Enter new folder name',
        placeHolder: 'e.g. Work, Personal, etc.'
      });
      
      if (folderName && folderName.trim()) {
        const newFolderId = generateVirtualFolderId(); // 🔧 FIX: 衝突防止のため乱数サフィックス付きIDに統一
        if (!meta.virtualFolders) {
          meta.virtualFolders = [];
        }
        meta.virtualFolders.push({
          id: newFolderId,
          name: folderName.trim(),
          order: meta.virtualFolders.length
        });
        this.saveFavoritesMeta(meta);
        virtualFolderId = newFolderId;
      } else {
        // フォルダ名が入力されなかった場合はキャンセル
        return;
      }
    }
    // 既存フォルダを選択
    else {
      // labelから "$(folder) " を削除してフォルダ名を取得
      const folderName = selectedFolder.label.replace('$(folder) ', '');
      const folder = virtualFolders.find(f => f.name === folderName);
      virtualFolderId = folder ? folder.id : null;
    }

    await this.addFavorite(filePath, '', isRelative, virtualFolderId);
  }

  // Add File with Context: 現在のファイルをプリフィルしてフォームを開く
  private async addFileWithContext() {
    const editor = vscode.window.activeTextEditor;
    
    if (editor) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (workspaceFolder) {
        const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
        
        // 既に登録されているか確認
        const favorites = this.loadFavorites();
        const isAlreadyRegistered = favorites[relativePath] !== undefined;
        
        // Webviewにファイルパスをプリフィルするよう通知
        // 既に登録されている場合は空のフォーム、登録されていない場合はパスをプリフィル
        if (this._view) {
          this._view.webview.postMessage({
            command: 'openAddFileForm',
            filePath: isAlreadyRegistered ? '' : relativePath
          });
        }
        return;
      }
    }
    
    // ファイルが開いていない場合は空のフォームを開く
    if (this._view) {
      this._view.webview.postMessage({
        command: 'openAddFileForm',
        filePath: ''
      });
    }
  }

  private async editFavorite(oldPath: string, newPath: string, description: string) {
    const favorites = this.loadFavorites();
    
    const oldData = favorites[oldPath];
    if (!oldData) {
      vscode.window.showErrorMessage('File not found in favorites');
      return;
    }
    
    if (oldPath !== newPath) {
      delete favorites[oldPath];
    }
    
    favorites[newPath] = { 
      path: newPath, 
      description,
      order: oldData.order !== undefined ? oldData.order : this.nextFavoriteOrder++,
      isRelative: oldData.isRelative !== undefined ? oldData.isRelative : true,
      virtualFolderId: oldData.virtualFolderId
    };
    this.saveFavorites(favorites);

    this.refresh();
    this.showInfo(`Updated "${newPath}"`);
  }

  private async removeFavorite(filePath: string) {
    const favorites = this.loadFavorites();
    const removedEntry = favorites[filePath];
    if (!removedEntry) return;

    delete favorites[filePath];
    this.saveFavorites(favorites);
    this.refresh();

    // 🆕 Undo対応
    this.showUndoableInfo(`Removed "${filePath}" from favorites`, () => {
      const current = this.loadFavorites();
      current[filePath] = removedEntry;
      this.saveFavorites(current);
      this.refresh();
    });
  }

  // 🆕 複数選択したFavoritesを一括削除
  private async bulkRemoveFavorites(paths: string[]) {
    if (!Array.isArray(paths) || paths.length === 0) return;

    const favorites = this.loadFavorites();
    const removedEntries: { [path: string]: FavoriteFile } = {};
    paths.forEach(p => {
      if (favorites[p]) {
        removedEntries[p] = favorites[p];
        delete favorites[p];
      }
    });

    const removedCount = Object.keys(removedEntries).length;
    if (removedCount === 0) return;

    this.saveFavorites(favorites);
    this.refresh();

    this.showUndoableInfo(`Removed ${removedCount} file(s) from favorites`, () => {
      const current = this.loadFavorites();
      Object.assign(current, removedEntries);
      this.saveFavorites(current);
      this.refresh();
    });
  }

  // 🆕 複数選択したFavoritesを一括でフォルダ移動
  private async bulkMoveFavoritesToFolder(paths: string[]) {
    if (!Array.isArray(paths) || paths.length === 0) return;

    const meta = this.loadFavoritesMeta();
    const virtualFolders = meta.virtualFolders || [];

    const folderItems: vscode.QuickPickItem[] = [
      { label: '$(inbox) Uncategorized', description: '' }
    ];
    if (virtualFolders.length > 0) {
      folderItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      virtualFolders.forEach(folder => {
        folderItems.push({ label: `$(folder) ${folder.name}`, description: '' });
      });
    }

    const selected = await vscode.window.showQuickPick(folderItems, {
      placeHolder: `Move ${paths.length} file(s) to...`,
      title: 'Move to Folder'
    });
    if (!selected) return;

    let targetFolderId: string | null = null;
    if (selected.label !== '$(inbox) Uncategorized') {
      const folderName = selected.label.replace('$(folder) ', '');
      const targetFolder = virtualFolders.find(f => f.name === folderName);
      targetFolderId = targetFolder ? targetFolder.id : null;
    }

    const favorites = this.loadFavorites();
    const previousFolders: { [path: string]: string | null | undefined } = {};
    let movedCount = 0;
    paths.forEach(p => {
      if (favorites[p]) {
        previousFolders[p] = favorites[p].virtualFolderId;
        favorites[p].virtualFolderId = targetFolderId;
        movedCount++;
      }
    });
    if (movedCount === 0) return;

    this.saveFavorites(favorites);
    this.refresh();

    const targetName = targetFolderId
      ? (virtualFolders.find(f => f.id === targetFolderId)?.name || 'folder')
      : 'Uncategorized';

    this.showUndoableInfo(`Moved ${movedCount} file(s) to "${targetName}"`, () => {
      const current = this.loadFavorites();
      Object.entries(previousFolders).forEach(([p, folderId]) => {
        if (current[p]) {
          current[p].virtualFolderId = folderId ?? null;
        }
      });
      this.saveFavorites(current);
      this.refresh();
    });
  }

  // 仮想フォルダを作成
  private async createVirtualFolder(name: string, parentId?: string | null) {
    if (!name || !name.trim()) {
      vscode.window.showErrorMessage('Folder name is required');
      return;
    }

    const meta = this.loadFavoritesMeta();
    if (!meta.virtualFolders) {
      meta.virtualFolders = [];
    }

    // パス指定の処理（a/b 形式）
    const pathParts = name.trim().split('/').filter(part => part.trim());
    
    if (pathParts.length === 0) {
      vscode.window.showErrorMessage('Folder name is required');
      return;
    }

    // parentIdを正規化（undefined を null に統一）
    let currentParentId: string | null = parentId === undefined || parentId === null ? null : parentId;
    let createdFolders: string[] = [];

    // 各パス部分を順番に作成
    for (let i = 0; i < pathParts.length; i++) {
      const folderName = pathParts[i].trim();
      
      // 既存のフォルダを検索（parentIdも正規化して比較）
      const existingFolder = meta.virtualFolders.find(f => {
        const fParentId = f.parentId === undefined || f.parentId === null ? null : f.parentId;
        return f.name === folderName && fParentId === currentParentId;
      });

      if (existingFolder) {
        // 既に存在する場合は、そのIDを次の親として使用
        currentParentId = existingFolder.id;
        createdFolders.push(folderName + ' (existing)');
      } else {
        // 新しいフォルダを作成（IDの衝突を避けるためランダム値を追加）
        const id = generateVirtualFolderId();
        const order = meta.virtualFolders.length;

        meta.virtualFolders.push({
          id: id,
          name: folderName,
          order: order,
          parentId: currentParentId
        });

        currentParentId = id;
        createdFolders.push(folderName);
      }
    }

    this.saveFavoritesMeta(meta);
    this.refresh();
    
    if (pathParts.length > 1) {
      this.showInfo(`Created folder path: ${pathParts.join(' / ')}`);
    } else {
      const parentFolder = parentId ? meta.virtualFolders.find(f => f.id === parentId) : null;
      const location = parentFolder ? `in "${parentFolder.name}"` : 'at root';
      this.showInfo(`Created virtual folder "${pathParts[0]}" ${location}`);
    }
  }

  // 仮想フォルダをリネーム
  private async renameVirtualFolder(id: string, newName: string) {
    if (!newName || !newName.trim()) {
      vscode.window.showErrorMessage('Folder name is required');
      return;
    }

    const meta = this.loadFavoritesMeta();
    if (!meta.virtualFolders) {
      return;
    }

    const folder = meta.virtualFolders.find(f => f.id === id);
    if (!folder) {
      vscode.window.showErrorMessage('Virtual folder not found');
      return;
    }

    folder.name = newName.trim();
    this.saveFavoritesMeta(meta);
    this.refresh();
    this.showInfo(`Renamed to "${newName}"`);
  }

  // 仮想フォルダを削除
  private async deleteVirtualFolder(id: string) {
    const meta = this.loadFavoritesMeta();
    if (!meta.virtualFolders) {
      return;
    }

    const folderIndex = meta.virtualFolders.findIndex(f => f.id === id);
    if (folderIndex === -1) {
      vscode.window.showErrorMessage('Virtual folder not found');
      return;
    }

    const folderName = meta.virtualFolders[folderIndex].name;
    
    // 子フォルダのIDを再帰的に収集
    const getAllChildFolderIds = (parentId: string): string[] => {
      const childIds: string[] = [];
      meta.virtualFolders?.forEach(folder => {
        if (folder.parentId === parentId) {
          childIds.push(folder.id);
          // 再帰的に孫フォルダも収集
          childIds.push(...getAllChildFolderIds(folder.id));
        }
      });
      return childIds;
    };
    
    const allFolderIdsToDelete = [id, ...getAllChildFolderIds(id)];
    
    // すべての削除対象フォルダをリストから削除
    meta.virtualFolders = meta.virtualFolders.filter(f => !allFolderIdsToDelete.includes(f.id));

    // このフォルダ（および子孫フォルダ）に所属していたファイルのvirtualFolderIdをnullに設定
    const favorites = this.loadFavorites();
    let updated = false;
    Object.keys(favorites).forEach(path => {
      if (allFolderIdsToDelete.includes(favorites[path].virtualFolderId as string)) {
        favorites[path].virtualFolderId = null;
        updated = true;
      }
    });

    this.saveFavoritesMeta(meta);
    if (updated) {
      this.saveFavorites(favorites);
    }
    this.refresh();
    this.showInfo(`Deleted virtual folder "${folderName}" and moved all files to Uncategorized`);
  }

  // 仮想フォルダの色を変更
  private async changeFolderColor(id: string, color: string) {
    const meta = this.loadFavoritesMeta();
    if (!meta.virtualFolders) {
      return;
    }

    const folder = meta.virtualFolders.find(f => f.id === id);
    if (!folder) {
      vscode.window.showErrorMessage('Virtual folder not found');
      return;
    }

    // 🔧 FIX(security): color は webview 側から postMessage で渡ってくる値であり、
    // 保存後は Webview 側で HTML の style 属性値として使われる。
    // "currentColor" または #RRGGBB / #RGB 形式のみを許可し、それ以外は無視することで、
    // 将来の実装変更等で不正な値がそのまま描画に使われる事態を防ぐ。
    const isValidColor = color === 'currentColor' || /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color);
    if (!isValidColor) {
      vscode.window.showErrorMessage('Core Anchor: Invalid color value');
      return;
    }

    folder.color = color;
    this.saveFavoritesMeta(meta);
    this.refresh();
    this.showInfo(`Changed color to ${color === 'currentColor' ? 'Default' : color}`);
  }

  // UI付きで色変更
  private async changeFolderColorWithUI(id: string) {
    const meta = this.loadFavoritesMeta();
    if (!meta.virtualFolders) return;

    const folder = meta.virtualFolders.find(f => f.id === id);
    if (!folder) return;

    const colors = [
      { label: '$(symbol-color) Default', value: 'currentColor' },
      { label: '$(symbol-color) Blue', value: '#4A9EFF' },
      { label: '$(symbol-color) Green', value: '#4CAF50' },
      { label: '$(symbol-color) Orange', value: '#FF9800' },
      { label: '$(symbol-color) Purple', value: '#9C27B0' },
      { label: '$(symbol-color) Red', value: '#F44336' },
      { label: '$(symbol-color) Pink', value: '#E91E63' },
      { label: '$(symbol-color) Teal', value: '#009688' },
      { label: '$(symbol-color) Yellow', value: '#FFC107' }
    ];

    const selected = await vscode.window.showQuickPick(colors, {
      placeHolder: `Choose a color for "${folder.name}"`
    });

    if (selected) {
      await this.changeFolderColor(id, selected.value);
    }
  }

  // UI付きでリネーム
  private async renameVirtualFolderWithUI(id: string, currentName: string) {
    const newName = await vscode.window.showInputBox({
      prompt: 'Enter new folder name',
      value: currentName,
      validateInput: (value) => {
        if (!value || !value.trim()) {
          return 'Folder name is required';
        }
        return null;
      }
    });

    if (newName && newName.trim() && newName.trim() !== currentName) {
      await this.renameVirtualFolder(id, newName.trim());
    }
  }

  // 確認付きで削除
  private async deleteVirtualFolderWithConfirm(id: string, folderName: string) {
    const answer = await vscode.window.showWarningMessage(
      `Delete folder "${folderName}"? Files will be moved to "Uncategorized".`,
      { modal: true },
      'Delete'
    );

    if (answer === 'Delete') {
      await this.deleteVirtualFolder(id);
    }
  }

  // UI付きでサブフォルダ作成
  private async createSubfolderWithUI(parentId: string, parentName: string) {
    const name = await vscode.window.showInputBox({
      prompt: `Create subfolder in "${parentName}"`,
      placeHolder: 'e.g. Components',
      validateInput: (value) => {
        if (!value || !value.trim()) {
          return 'Folder name is required';
        }
        return null;
      }
    });

    if (name && name.trim()) {
      await this.createVirtualFolder(name.trim(), parentId);
    }
  }

  // ファイルを別の仮想フォルダに移動
  private async moveFileToFolder(filePath: string, targetFolderId: string | null) {
    const favorites = this.loadFavorites();
    
    if (!favorites[filePath]) {
      vscode.window.showErrorMessage('File not found in favorites');
      return;
    }

    const oldFolderId = favorites[filePath].virtualFolderId;
    favorites[filePath].virtualFolderId = targetFolderId;
    
    this.saveFavorites(favorites);
    this.refresh();
    
    // フォルダ名を取得
    let targetFolderName = 'No Folder';
    if (targetFolderId) {
      const meta = this.loadFavoritesMeta();
      const targetFolder = meta.virtualFolders?.find(f => f.id === targetFolderId);
      if (targetFolder) {
        targetFolderName = targetFolder.name;
      }
    }
    
    const fileName = path.basename(filePath);
    this.showInfo(`Moved "${fileName}" to "${targetFolderName}"`);
  }

  // 🆕 ドラッグ&ドロップで複数選択したFavoritesを、ドロップ先フォルダへ直接移動する。
  // bulkMoveFavoritesToFolder（バルクアクションバーの「Move」ボタン用）とは異なり、
  // ドロップ先フォルダは既にUI側（ドロップされたfolder-group）で確定しているため、
  // QuickPickによるフォルダ選択は行わない。
  private async moveFilesToFolder(filePaths: string[], targetFolderId: string | null) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return;

    const favorites = this.loadFavorites();
    const previousFolders: { [path: string]: string | null | undefined } = {};
    let movedCount = 0;
    filePaths.forEach(p => {
      if (favorites[p]) {
        previousFolders[p] = favorites[p].virtualFolderId;
        favorites[p].virtualFolderId = targetFolderId;
        movedCount++;
      }
    });
    if (movedCount === 0) return;

    this.saveFavorites(favorites);
    this.refresh();

    const meta = this.loadFavoritesMeta();
    const targetName = targetFolderId
      ? (meta.virtualFolders?.find(f => f.id === targetFolderId)?.name || 'folder')
      : 'Uncategorized';

    this.showUndoableInfo(`Moved ${movedCount} file(s) to "${targetName}"`, () => {
      const current = this.loadFavorites();
      Object.entries(previousFolders).forEach(([p, folderId]) => {
        if (current[p]) {
          current[p].virtualFolderId = folderId ?? null;
        }
      });
      this.saveFavorites(current);
      this.refresh();
    });
  }

  // 仮想フォルダを別の仮想フォルダに移動（サブフォルダ化）
  private async moveFolderToFolder(folderId: string, targetParentId: string | null) {
    const meta = this.loadFavoritesMeta();
    if (!meta.virtualFolders) {
      return;
    }

    const folder = meta.virtualFolders.find(f => f.id === folderId);
    if (!folder) {
      vscode.window.showErrorMessage('Folder not found');
      return;
    }

    // 自分自身には移動できない
    if (folderId === targetParentId) {
      vscode.window.showErrorMessage('Cannot move folder into itself');
      return;
    }

    // 循環参照チェック（自分の子孫フォルダには移動できない）
    if (targetParentId && this.isDescendant(meta.virtualFolders, targetParentId, folderId)) {
      vscode.window.showErrorMessage('Cannot move folder into its own descendant');
      return;
    }

    const oldParentId = folder.parentId;
    folder.parentId = targetParentId;
    
    this.saveFavoritesMeta(meta);
    this.refresh();
    
    // 移動先フォルダ名を取得
    let targetFolderName = 'Root';
    if (targetParentId) {
      const targetFolder = meta.virtualFolders.find(f => f.id === targetParentId);
      if (targetFolder) {
        targetFolderName = targetFolder.name;
      }
    }
    
    this.showInfo(`Moved folder "${folder.name}" to "${targetFolderName}"`);
  }

  // ファイル並び替え（同一フォルダ内）
  private async reorderFilesInFolder(
    folderId: string | null, 
    draggedFile: string, 
    targetFile: string, 
    position: 'before' | 'after'
  ) {
    const meta = this.loadFavoritesMeta();
    
    // fileOrder を初期化（存在しない場合）
    if (!meta.fileOrder) {
      meta.fileOrder = {};
    }
    
    const folderKey = folderId || '(root)';
    
    // 現在のファイル一覧を取得
    const favorites = this.loadFavorites();
    const filesInFolder = Object.keys(favorites).filter(path => {
      const file = favorites[path];
      const fileFolderId = file.virtualFolderId || null;
      return fileFolderId === folderId;
    });
    
    // 既存の並び順がある場合はそれを使用、なければ現在の順序
    let fileOrder = meta.fileOrder[folderKey] || filesInFolder;
    
    // fileOrder から存在しないファイルを削除（クリーンアップ）
    fileOrder = fileOrder.filter(f => filesInFolder.includes(f));
    
    // filesInFolder にあるが fileOrder にないファイルを末尾に追加
    const missingFiles = filesInFolder.filter(f => !fileOrder.includes(f));
    fileOrder = [...fileOrder, ...missingFiles];
    
    // draggedFile を削除
    fileOrder = fileOrder.filter(f => f !== draggedFile);
    
    // targetFile の位置を探して挿入
    const targetIndex = fileOrder.indexOf(targetFile);
    if (targetIndex === -1) {
      // targetFile が見つからない場合は末尾に追加
      fileOrder.push(draggedFile);
    } else {
      const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
      fileOrder.splice(insertIndex, 0, draggedFile);
    }
    
    meta.fileOrder[folderKey] = fileOrder;
    this.saveFavoritesMeta(meta);
    this.refresh();
  }

  // フォルダ並び替え（同一階層内）
  private async reorderFolders(
    draggedFolderId: string, 
    targetFolderId: string, 
    position: 'before' | 'after',
    parentId: string | null
  ) {
    const meta = this.loadFavoritesMeta();
    if (!meta.virtualFolders) {
      return;
    }
    
    // 同一親階層のフォルダを取得
    const sameLevelFolders = meta.virtualFolders.filter(f => 
      (f.parentId || null) === parentId
    );
    
    // order でソート
    sameLevelFolders.sort((a, b) => (a.order || 0) - (b.order || 0));
    
    // draggedFolder を削除
    const draggedIndex = sameLevelFolders.findIndex(f => f.id === draggedFolderId);
    if (draggedIndex === -1) {
      return;
    }
    const draggedFolder = sameLevelFolders.splice(draggedIndex, 1)[0];
    
    // targetFolder の位置を探して挿入
    const targetIndex = sameLevelFolders.findIndex(f => f.id === targetFolderId);
    if (targetIndex === -1) {
      return;
    }
    
    const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
    sameLevelFolders.splice(insertIndex, 0, draggedFolder);
    
    // order を再割り当て
    sameLevelFolders.forEach((folder, index) => {
      folder.order = index;
    });
    
    this.saveFavoritesMeta(meta);
    this.refresh();
  }


  // フォルダAがフォルダBの子孫かどうかチェック（循環参照ガード付き）
  private isDescendant(folders: VirtualFolder[], checkId: string, ancestorId: string, visited = new Set<string>()): boolean {
    if (visited.has(checkId)) return false; // 循環参照を検出したら false
    visited.add(checkId);
    const folder = folders.find(f => f.id === checkId);
    if (!folder) return false;
    if (!folder.parentId) return false;
    if (folder.parentId === ancestorId) return true;
    return this.isDescendant(folders, folder.parentId, ancestorId, visited);
  }

  private async openFile(filePath: string, openToSide: boolean = false) {
    const workspaceFolders = vscode.workspace.workspaceFolders;

    let uri: vscode.Uri;

    // 絶対パス（ワークスペース外ファイル）はそのまま URI に変換
    // 相対パスはワークスペースルートと結合
    if (path.isAbsolute(filePath)) {
      uri = vscode.Uri.file(filePath);
    } else {
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder is open');
        return;
      }
      const root = workspaceFolders[0].uri.fsPath;
      const fullPath = path.join(root, filePath);

      // 🔧 FIX(security): 相対パスのFavoriteが「../」等でワークスペース外を指している場合、
      // 悪意あるリポジトリに仕込まれた不正な favorites.json によって、ユーザーが気づかないまま
      // ワークスペース外の任意ファイル（例: ~/.ssh/id_rsa）を開いてしまう可能性がある。
      // 完全に禁止すると意図的な用途（モノレポ等）を壊すため、開く前に確認を挟む。
      if (!isPathWithinRoot(root, fullPath)) {
        const choice = await vscode.window.showWarningMessage(
          `This favorite points outside the workspace folder:\n${fullPath}\n\nOpen it anyway?`,
          { modal: true },
          'Open'
        );
        if (choice !== 'Open') {
          return;
        }
      }

      uri = vscode.Uri.file(fullPath);
    }

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      
      // 設定からプレビューモードを取得
      const config = vscode.workspace.getConfiguration('core-anchor');
      const openInPreview = config.get<boolean>('ui.openInPreview', true);
      
      // openToSideパラメータで分岐
      if (openToSide) {
        await vscode.window.showTextDocument(document, {
          preview: openInPreview,
          viewColumn: vscode.ViewColumn.Beside
        });
      } else {
        await vscode.window.showTextDocument(document, {
          preview: openInPreview
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Cannot open file: ${filePath}`);
    }
  }

  private getIconPath(iconType: BookmarkIconType): string {
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
    
    return this.context.asAbsolutePath(path.join('resources', `bookmark-${iconType}.png`));
  }

  private async addBookmark() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor');
      return;
    }

    // ブックマークは .vscode/bookmarks.json に保存するためワークスペース自体は必要
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder is open');
      return;
    }

    // ワークスペース内なら相対パス、外なら絶対パスを使用（favorites と同様）
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const filePath = workspaceFolder
      ? vscode.workspace.asRelativePath(editor.document.uri)
      : editor.document.uri.fsPath;

    const line = editor.selection.active.line;

    // ① skipIconSelect: true の場合はアイコン選択をスキップしてデフォルトを使用
    const config = vscode.workspace.getConfiguration('core-anchor');
    const skipIconSelect = config.get<boolean>('bookmarks.skipIconSelect', false);

    let chosenIconType: BookmarkIconType = 'default';

    if (!skipIconSelect) {
      const iconTypeItems = Object.entries(ICON_TYPE_LABELS)
        .filter(([value]) => value !== 'all') // 'all'アイコンは除外
        .map(([value, label]) => {
          const iconPath = this.getIconPath(value as BookmarkIconType);
          return {
            label,
            value: value as BookmarkIconType,
            iconPath: vscode.Uri.file(iconPath)
          };
        });

      const selectedIconType = await vscode.window.showQuickPick(iconTypeItems, {
        placeHolder: 'Select bookmark icon type',
      });

      if (!selectedIconType) return;
      chosenIconType = selectedIconType.value;
    }

    const label = await vscode.window.showInputBox({
      prompt: 'Enter bookmark label',
      placeHolder: 'e.g. TODO',
    });

    if (label === undefined) return;

    const bookmarksPath = this.getBookmarksPath();
    let bookmarks: BookmarksData = this.readBookmarksFileSafe(bookmarksPath);

    if (!bookmarks[filePath]) {
      bookmarks[filePath] = [];
    }

    // orderを初期化
    let maxOrder = 0;
    bookmarks[filePath].forEach(b => {
      if (b.order !== undefined && b.order > maxOrder) {
        maxOrder = b.order;
      }
    });

    // 同じ行に既存のブックマークがあれば削除（上書き）
    bookmarks[filePath] = bookmarks[filePath].filter(b => b.line !== line);

    bookmarks[filePath].push({ 
      line, 
      label,
      iconType: chosenIconType,
      order: maxOrder + 1
    });

    // 現在のソートタイプに応じて自動ソート
    const meta = this.loadBookmarksMeta();
    const sortType = meta.globalSortType || 'line';
    if (sortType === 'line') {
      bookmarks[filePath].sort((a, b) => a.line - b.line);
    }
    // 'order' の場合はpushしたまま（末尾=追加順）でOK
    
    this.saveBookmarks(bookmarks);
    this.refresh();
    
    if (this.decorationTypes) {
      this.updateDecorations(editor);
    }
    
    this.showInfo(`Bookmark added at line ${line + 1}`);
  }

  async addBookmarkFromCommand() {
    await this.addBookmark();
  }

  // サイドバーの「+ Add Bookmark」ボタン用:
  // 現在アクティブなエディタのファイルパスとカーソル行をプリフィルしてフォームを開く
  private async addBookmarkWithContext() {
    if (!this._view) return;

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      // ワークスペース内なら相対パス、外なら絶対パスをプリフィル（favorites と同様）
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      const filePath = workspaceFolder
        ? vscode.workspace.asRelativePath(editor.document.uri)
        : editor.document.uri.fsPath;
      // カーソル行を 1-indexed で送る（フォームの表示は 1-indexed）
      const lineNumber = editor.selection.active.line + 1;
      this._view.webview.postMessage({
        command: 'openAddBookmarkForm',
        filePath: filePath,
        lineNumber: lineNumber
      });
      return;
    }

    // エディタが開いていない場合は空フォームを開く
    this._view.webview.postMessage({
      command: 'openAddBookmarkForm',
      filePath: '',
      lineNumber: null
    });
  }

  private async addFavoriteFromEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor');
      return;
    }

    // ワークスペース自体が開いているか確認（ファイルがワークスペース外でもOK）
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder is open');
      return;
    }

    // ファイルがワークスペース内なら相対パス、外なら絶対パスを使用
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const filePath = workspaceFolder
      ? vscode.workspace.asRelativePath(editor.document.uri)
      : editor.document.uri.fsPath;

    // フォルダ選択QuickPick
    const meta = this.loadFavoritesMeta();
    const virtualFolders = meta.virtualFolders || [];
    
    const folderItems: vscode.QuickPickItem[] = [
      {
        label: '$(inbox) Uncategorized',
        description: ''
      }
    ];
    
    folderItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    
    folderItems.push({
      label: '$(add) Create New Folder',
      description: ''
    });
    
    if (virtualFolders.length > 0) {
      folderItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      
      virtualFolders.forEach(folder => {
        folderItems.push({
          label: `$(folder) ${folder.name}`,
          description: ''
        });
      });
    }
    
    const selectedFolder = await vscode.window.showQuickPick(folderItems, {
      placeHolder: 'Select a folder (or press Escape to cancel)',
      title: 'Add to Favorites'
    });
    
    // キャンセルされた場合は追加しない
    if (!selectedFolder) {
      return;
    }
    
    let virtualFolderId: string | null = null;
    
    // Uncategorizedを選択
    if (selectedFolder.label === '$(inbox) Uncategorized') {
      virtualFolderId = null;
    }
    // 新規フォルダ作成
    else if (selectedFolder.label === '$(add) Create New Folder') {
      const folderName = await vscode.window.showInputBox({
        prompt: 'Enter new folder name',
        placeHolder: 'e.g. Work, Personal, etc.'
      });
      
      if (folderName && folderName.trim()) {
        const newFolderId = generateVirtualFolderId(); // 🔧 FIX: 衝突防止のため乱数サフィックス付きIDに統一
        if (!meta.virtualFolders) {
          meta.virtualFolders = [];
        }
        meta.virtualFolders.push({
          id: newFolderId,
          name: folderName.trim(),
          order: meta.virtualFolders.length
        });
        this.saveFavoritesMeta(meta);
        virtualFolderId = newFolderId;
      } else {
        // フォルダ名が入力されなかった場合はキャンセル
        return;
      }
    }
    // 既存フォルダを選択
    else {
      // labelから "$(folder) " を削除してフォルダ名を取得
      const folderName = selectedFolder.label.replace('$(folder) ', '');
      const folder = virtualFolders.find(f => f.name === folderName);
      virtualFolderId = folder ? folder.id : null;
    }

    // ④ skipDescriptionOnAdd: true の場合は説明入力をスキップして空文字で追加
    const config = vscode.workspace.getConfiguration('core-anchor');
    const skipDescription = config.get<boolean>('favorites.skipDescriptionOnAdd', false);

    let description = '';
    if (!skipDescription) {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter file description (optional)',
        placeHolder: 'e.g. Entry point',
      });

      // undefined はキャンセル操作なので追加しない
      if (input === undefined) return;
      description = input;
    }

    await this.addFavorite(filePath, description, !!workspaceFolder, virtualFolderId);
  }

  async addFavoriteFromCommand() {
    await this.addFavoriteFromEditor();
  }

  // ブックマークを上に移動
  async moveBookmarkUp() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor');
      return;
    }

    const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
    const currentLine = editor.selection.active.line;
    
    const bookmarks = this.loadBookmarks();
    
    if (!bookmarks[relativePath]) {
      this.showInfo('No bookmarks in this file');
      return;
    }

    // 現在行のブックマークを探す
    const bookmarkIndex = bookmarks[relativePath].findIndex(b => b.line === currentLine);
    
    if (bookmarkIndex === -1) {
      this.showInfo('No bookmark on current line');
      return;
    }

    // 1行上に移動できるか確認
    const newLine = currentLine - 1;
    if (newLine < 0) {
      this.showInfo('Already at the top');
      return;
    }

    // 移動先に既にブックマークがあるか確認
    const existingIndex = bookmarks[relativePath].findIndex(b => b.line === newLine);
    if (existingIndex !== -1) {
      this.showInfo('Bookmark already exists on target line');
      return;
    }

    // ブックマークを移動
    bookmarks[relativePath][bookmarkIndex].line = newLine;
    
    this.saveBookmarks(bookmarks);
    this.refresh();
    
    if (this.decorationTypes) {
      this.updateDecorations(editor);
    }
    
    this.showInfo(`Bookmark moved to line ${newLine + 1}`);
  }

  // ブックマークを下に移動
  async moveBookmarkDown() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor');
      return;
    }

    const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
    const currentLine = editor.selection.active.line;
    
    const bookmarks = this.loadBookmarks();
    
    if (!bookmarks[relativePath]) {
      this.showInfo('No bookmarks in this file');
      return;
    }

    // 現在行のブックマークを探す
    const bookmarkIndex = bookmarks[relativePath].findIndex(b => b.line === currentLine);
    
    if (bookmarkIndex === -1) {
      this.showInfo('No bookmark on current line');
      return;
    }

    // 1行下に移動できるか確認
    const newLine = currentLine + 1;
    if (newLine >= editor.document.lineCount) {
      this.showInfo('Already at the bottom');
      return;
    }

    // 移動先に既にブックマークがあるか確認
    const existingIndex = bookmarks[relativePath].findIndex(b => b.line === newLine);
    if (existingIndex !== -1) {
      this.showInfo('Bookmark already exists on target line');
      return;
    }

    // ブックマークを移動
    bookmarks[relativePath][bookmarkIndex].line = newLine;
    
    this.saveBookmarks(bookmarks);
    this.refresh();
    
    if (this.decorationTypes) {
      this.updateDecorations(editor);
    }
    
    this.showInfo(`Bookmark moved to line ${newLine + 1}`);
  }

  private async addBookmarkManual(filePath: string, lineStr: string, label: string, iconType?: string) {
    if (!filePath.trim() || !lineStr.trim()) {
      vscode.window.showErrorMessage('File path and line number are required');
      return;
    }

    const line = parseInt(lineStr) - 1;
    if (isNaN(line) || line < 0) {
      vscode.window.showErrorMessage('Invalid line number');
      return;
    }

    const bookmarksPath = this.getBookmarksPath();
    let bookmarks: BookmarksData = this.readBookmarksFileSafe(bookmarksPath);

    if (!bookmarks[filePath]) {
      bookmarks[filePath] = [];
    }

    // orderを初期化
    let maxOrder = 0;
    bookmarks[filePath].forEach(b => {
      if (b.order !== undefined && b.order > maxOrder) {
        maxOrder = b.order;
      }
    });

    // 同じ行に既存のブックマークがあれば削除（上書き）
    bookmarks[filePath] = bookmarks[filePath].filter(b => b.line !== line);

    bookmarks[filePath].push({ 
      line, 
      label: label || '', 
      iconType: (iconType as any) || 'default',
      order: maxOrder + 1
    });

    // 現在のソートタイプに応じて自動ソート
    const meta = this.loadBookmarksMeta();
    const sortType = meta.globalSortType || 'line';
    if (sortType === 'line') {
      bookmarks[filePath].sort((a, b) => a.line - b.line);
    }
    // 'order' の場合はpushしたまま（末尾=追加順）でOK
    
    this.saveBookmarks(bookmarks);
    this.refresh();
    
    const editor = vscode.window.activeTextEditor;
    if (editor && vscode.workspace.asRelativePath(editor.document.uri) === filePath && this.decorationTypes) {
      this.updateDecorations(editor);
    }
    
    this.showInfo(`Bookmark added: ${filePath}:${line + 1}`);
  }

  private async editBookmark(filePath: string, oldLine: number, newLineStr: string, label: string, iconType?: string) {
    const newLine = parseInt(newLineStr) - 1;
    if (isNaN(newLine) || newLine < 0) {
      vscode.window.showErrorMessage('Invalid line number');
      return;
    }

    const bookmarksPath = this.getBookmarksPath();
    if (!fs.existsSync(bookmarksPath)) return;

    const bookmarks: BookmarksData = this.readBookmarksFileSafe(bookmarksPath);

    if (bookmarks[filePath]) {
      const index = bookmarks[filePath].findIndex(b => b.line === oldLine);
      if (index !== -1) {
        const currentIconType = bookmarks[filePath][index].iconType || 'default';
        const currentOrder = bookmarks[filePath][index].order;
        bookmarks[filePath][index] = { 
          line: newLine, 
          label, 
          iconType: (iconType as any) || currentIconType,
          order: currentOrder
        };
      }
    }

    this.saveBookmarks(bookmarks);
    this.refresh();
    
    const editor = vscode.window.activeTextEditor;
    if (editor && vscode.workspace.asRelativePath(editor.document.uri) === filePath && this.decorationTypes) {
      this.updateDecorations(editor);
    }
    
    this.showInfo(`Bookmark updated`);
  }

  private async removeBookmark(filePath: string, line: number) {
    const bookmarksPath = this.getBookmarksPath();
    if (!fs.existsSync(bookmarksPath)) return;

    const bookmarks: BookmarksData = this.readBookmarksFileSafe(bookmarksPath);

    let removedBookmark: Bookmark | undefined;
    if (bookmarks[filePath]) {
      removedBookmark = bookmarks[filePath].find(b => b.line === line);
      bookmarks[filePath] = bookmarks[filePath].filter(b => b.line !== line);
      if (bookmarks[filePath].length === 0) {
        delete bookmarks[filePath];
      }
    }

    this.saveBookmarks(bookmarks);
    this.refresh();
    
    const editor = vscode.window.activeTextEditor;
    if (editor && this.decorationTypes) {
      this.updateDecorations(editor);
    }

    // 🆕 Undo対応
    if (removedBookmark) {
      const bookmarkToRestore = removedBookmark;
      this.showUndoableInfo(`Removed bookmark "${bookmarkToRestore.label || 'Line ' + (line + 1)}"`, () => {
        const current = this.readBookmarksFileSafe(this.getBookmarksPath());
        if (!current[filePath]) {
          current[filePath] = [];
        }
        if (!current[filePath].some(b => b.line === bookmarkToRestore.line)) {
          current[filePath].push(bookmarkToRestore);
        }
        this.resortBookmarksForFile(current, filePath);
        this.saveBookmarks(current);
        this.refresh();
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && this.decorationTypes) {
          this.updateDecorations(activeEditor);
        }
      });
    }
  }

  // 🆕 複数選択したBookmarksを一括削除
  private async bulkRemoveBookmarks(items: { filePath: string; line: number }[]) {
    if (!Array.isArray(items) || items.length === 0) return;

    const bookmarksPath = this.getBookmarksPath();
    const bookmarks: BookmarksData = this.readBookmarksFileSafe(bookmarksPath);
    const removedByFile: BookmarksData = {};
    let removedCount = 0;

    items.forEach(({ filePath, line }) => {
      if (!bookmarks[filePath]) return;
      const idx = bookmarks[filePath].findIndex(b => b.line === line);
      if (idx === -1) return;
      if (!removedByFile[filePath]) {
        removedByFile[filePath] = [];
      }
      removedByFile[filePath].push(bookmarks[filePath][idx]);
      bookmarks[filePath].splice(idx, 1);
      removedCount++;
      if (bookmarks[filePath].length === 0) {
        delete bookmarks[filePath];
      }
    });

    if (removedCount === 0) return;

    this.saveBookmarks(bookmarks);
    this.refresh();

    const editor = vscode.window.activeTextEditor;
    if (editor && this.decorationTypes) {
      this.updateDecorations(editor);
    }

    this.showUndoableInfo(`Removed ${removedCount} bookmark(s)`, () => {
      const current = this.readBookmarksFileSafe(this.getBookmarksPath());
      Object.entries(removedByFile).forEach(([filePath, marks]) => {
        if (!current[filePath]) {
          current[filePath] = [];
        }
        marks.forEach(m => {
          if (!current[filePath].some(b => b.line === m.line)) {
            current[filePath].push(m);
          }
        });
        this.resortBookmarksForFile(current, filePath);
      });
      this.saveBookmarks(current);
      this.refresh();
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && this.decorationTypes) {
        this.updateDecorations(activeEditor);
      }
    });
  }

  // ファイル内の全ブックマークを削除
  private async deleteAllBookmarks(filePath: string) {
    const bookmarksPath = this.getBookmarksPath();
    if (!fs.existsSync(bookmarksPath)) return;

    const bookmarks: BookmarksData = this.readBookmarksFileSafe(bookmarksPath);

    if (bookmarks[filePath]) {
      const count = bookmarks[filePath].length;
      const removedBookmarks = bookmarks[filePath];
      delete bookmarks[filePath];
      
      this.saveBookmarks(bookmarks);
      this.refresh();
      
      const editor = vscode.window.activeTextEditor;
      if (editor && this.decorationTypes) {
        this.updateDecorations(editor);
      }
      
      // 🆕 Undo対応
      this.showUndoableInfo(`Deleted ${count} bookmarks from ${filePath}`, () => {
        const current = this.readBookmarksFileSafe(this.getBookmarksPath());
        current[filePath] = removedBookmarks;
        this.resortBookmarksForFile(current, filePath);
        this.saveBookmarks(current);
        this.refresh();
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && this.decorationTypes) {
          this.updateDecorations(activeEditor);
        }
      });
    }
  }

  // フォルダ内の全Favoritesを削除
  private async deleteAllFavorites(folderPath: string) {
    const favorites = this.loadFavorites();
    
    const filesToDelete = Object.keys(favorites).filter(filePath => {
      const parts = filePath.split('/');
      const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
      return folder === folderPath;
    });
    
    if (filesToDelete.length > 0) {
      const removedEntries: { [path: string]: FavoriteFile } = {};
      filesToDelete.forEach(filePath => {
        removedEntries[filePath] = favorites[filePath];
        delete favorites[filePath];
      });
      
      this.saveFavorites(favorites);
      this.refresh();
      
      // 🆕 Undo対応
      this.showUndoableInfo(`Deleted ${filesToDelete.length} files from favorites`, () => {
        const current = this.loadFavorites();
        Object.assign(current, removedEntries);
        this.saveFavorites(current);
        this.refresh();
      });
    }
  }

  private async jumpToBookmark(filePath: string, line: number, openToSide: boolean = false) {
    await this.openFile(filePath, openToSide);
    
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const position = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }

    // ハイライト通知
    this.highlightBookmark(filePath, line);
  }

  // ブックマークをハイライト（public）
  highlightBookmark(filePath: string, line: number) {
    if (this._view) {
      this._view.webview.postMessage({
        command: 'setHighlightedBookmark',
        filePath: filePath,
        line: line
      });
    }
  }

  private getBookmarksPath(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return '';

    const vscodeFolder = path.join(workspaceFolders[0].uri.fsPath, '.vscode');
    if (!fs.existsSync(vscodeFolder)) {
      fs.mkdirSync(vscodeFolder);
    }

    return path.join(vscodeFolder, 'bookmarks.json');
  }

  // 🔧 FIX: Undoで復元したブックマークが常に末尾に追加され、
  // 「Line」ソート中でも行番号順を無視してしまっていた。
  // addBookmarkManual と同じく、現在の globalSortType に従って再ソートする。
  private resortBookmarksForFile(bookmarks: BookmarksData, filePath: string) {
    if (!bookmarks[filePath]) return;
    const meta = this.loadBookmarksMeta();
    const sortType = meta.globalSortType || 'line';
    if (sortType === 'line') {
      bookmarks[filePath].sort((a, b) => a.line - b.line);
    } else if (sortType === 'order') {
      bookmarks[filePath].sort((a, b) => (a.order || 0) - (b.order || 0));
    }
  }

  private saveBookmarks(bookmarks: BookmarksData) {
    const bookmarksPath = this.getBookmarksPath();
    fs.writeFileSync(bookmarksPath, JSON.stringify(bookmarks, null, 2));
  }

  // 🔧 FIX(robustness): bookmarks.json の読み込みは複数箇所で行われているが、
  // 一部は try/catch で保護されておらず、ファイルが破損している場合（クラッシュ・
  // SSH切断中の書き込み・Gitコンフリクト等）に例外が伝播してコマンドが失敗し、
  // 最悪の場合ブックマーク機能全体が動かなくなる恐れがあった。
  // 読み込みを一元化し、パース失敗時は空データにフォールバックしつつユーザーに通知する。
  private readBookmarksFileSafe(bookmarksPath: string): BookmarksData {
    if (!bookmarksPath || !fs.existsSync(bookmarksPath)) {
      return {};
    }
    try {
      const content = fs.readFileSync(bookmarksPath, 'utf-8');
      // 🔧 FIX(security): bookmarks.json はワークスペース単位で共有されうる信頼できない入力のため、
      // JSON.parse直後に型を強制する（不正な line 等がWebview側で未エスケープのまま
      // HTML属性値に埋め込まれることを防ぐ）。
      return sanitizeBookmarksData(JSON.parse(content));
    } catch (error) {
      console.error('Error loading bookmarks.json:', error);
      vscode.window.showErrorMessage(
        'Core Anchor: bookmarks.json is corrupted and could not be read. Please fix or remove .vscode/bookmarks.json.'
      );
      return {};
    }
  }

  private loadBookmarks(): BookmarksData {
    const bookmarksPath = this.getBookmarksPath();
    const raw = this.readBookmarksFileSafe(bookmarksPath);

    // Windows 環境で保存されたデータにバックスラッシュが混入している場合に備え、
    // すべてのキーをスラッシュ区切りに正規化する。
    const normalized: BookmarksData = {};
    for (const [key, value] of Object.entries(raw)) {
      normalized[key.replace(/\\/g, '/')] = value;
    }
    return normalized;
  }

  private getHtmlContent(webview: vscode.Webview): string {
    return getHtmlContent(webview);
  }

  // ショートカットでカーソル行のブックマーク情報をコード上にポップアップ表示
  showBookmarkAtCursor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const line = editor.selection.active.line;
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
    const bookmarks = this.loadBookmarks();

    if (bookmarks[relativePath]) {
      const bookmark = bookmarks[relativePath].find(b => b.line === line);
      if (bookmark) {
        // 既存のホバーを表示するだけ（editor.action.showHoverコマンド）
        vscode.commands.executeCommand('editor.action.showHover');
        return;
      }
    }

    // ブックマークがない場合は何も表示しない
  }

  updateDecorations(editor: vscode.TextEditor) {
    if (!this.decorationTypes) {
      console.error('[Core Anchor] CRITICAL ERROR: decorationTypes is NULL or UNDEFINED!');
      console.error('[Core Anchor] This means setDecorationTypes() was not called or failed');
      return;
    }

    const bookmarks = this.loadBookmarks();
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
    
    const decorationsByType: Map<BookmarkIconType, vscode.DecorationOptions[]> = new Map();
    
    if (bookmarks[relativePath]) {
      bookmarks[relativePath].forEach((bookmark, index) => {
        const iconType = bookmark.iconType || 'default';
        
        // 行内容を取得してrangeを決定
        let lineContent = '';
        let lineLength = 0;
        try {
          if (bookmark.line < editor.document.lineCount) {
            const lineText = editor.document.lineAt(bookmark.line).text;
            lineContent = lineText.trim();
            lineLength = lineText.length;
            
            // 長すぎる場合は切り詰め
            if (lineContent.length > 80) {
              const original = lineContent;
              lineContent = lineContent.substring(0, 77) + '...';
            }
          } else {
            console.warn(`[Core Anchor] ⚠️  WARNING: Bookmark line ${bookmark.line} >= document line count ${editor.document.lineCount}`);
          }
        } catch (error) {
          console.error('[Core Anchor] ❌ ERROR getting line content:', error);
          if (error instanceof Error) {
            console.error('[Core Anchor] Error message:', error.message);
            console.error('[Core Anchor] Error stack:', error.stack);
          }
        }
        
        // 行の実際の文字がある範囲のみをカバー
        const range = new vscode.Range(bookmark.line, 0, bookmark.line, lineLength);
        
        // ホバーメッセージ：種類+内容のみ（コードプレビューなし）
        const hoverText = bookmark.label 
          ? `**${ICON_TYPE_LABELS[iconType]}**: ${bookmark.label}` 
          : `**${ICON_TYPE_LABELS[iconType]}** (Line ${bookmark.line + 1})`;
        
        const hoverMsg = new vscode.MarkdownString(hoverText);
        
        if (!decorationsByType.has(iconType)) {
          decorationsByType.set(iconType, []);
        }
        
        const decoration: vscode.DecorationOptions = {
          range,
          hoverMessage: hoverMsg,
        };
        
        decorationsByType.get(iconType)!.push(decoration);
      });
    }
    
    let totalDecorationsApplied = 0;
    
    this.decorationTypes.forEach((decorationType, iconType) => {
      const decorations = decorationsByType.get(iconType) || [];
      
      if (decorations.length > 0) {
        totalDecorationsApplied += decorations.length;
      }
      
      try {
        editor.setDecorations(decorationType, decorations);
      } catch (error) {
        console.error(`[Core Anchor]   ❌ ERROR applying decorations:`, error);
      }
    });
  }

  refresh() {
    if (this._view) {
      const favorites = this.loadFavorites();
      const bookmarks = this.loadBookmarks();
      const favoritesMeta = this.loadFavoritesMeta();
      const bookmarksMeta = this.loadBookmarksMeta();
      
      // ブックマークに行内容を追加
      const bookmarksWithContent: any = {};
      const workspaceFolders = vscode.workspace.workspaceFolders;
      
      if (workspaceFolders) {
        Object.entries(bookmarks).forEach(([filePath, marks]) => {
          // 絶対パス（ワークスペース外ファイル）はそのまま使用
          const fullPath = path.isAbsolute(filePath)
            ? filePath
            : path.join(workspaceFolders[0].uri.fsPath, filePath);
          bookmarksWithContent[filePath] = [];
          
          marks.forEach(mark => {
            let lineContent = '';
            try {
              if (fs.existsSync(fullPath)) {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const lines = content.split('\n');
                if (mark.line < lines.length) {
                  lineContent = lines[mark.line].trim();
                  // 長すぎる場合は切り詰め
                  if (lineContent.length > 80) {
                    lineContent = lineContent.substring(0, 77) + '...';
                  }
                }
              }
            } catch (error) {
              // エラーの場合は空文字列
            }
            
            bookmarksWithContent[filePath].push({
              ...mark,
              lineContent: lineContent
            });
          });
        });
      } else {
        Object.assign(bookmarksWithContent, bookmarks);
      }
      
      // ファイルアイコンのマッピングを生成
      const fileIcons: { [key: string]: string } = {};
      Object.keys(favorites).forEach(filePath => {
        const iconName = this.getMaterialIconName(filePath);
        const iconPath = path.join(this.context.extensionPath, 'resources', 'file-icons', `${iconName}.svg`);
        
        try {
          if (fs.existsSync(iconPath)) {
            const iconUri = this._view!.webview.asWebviewUri(vscode.Uri.file(iconPath));
            fileIcons[filePath] = iconUri.toString();
          } else {
            // フォールバック: デフォルトのfileアイコン
            const defaultIconPath = path.join(this.context.extensionPath, 'resources', 'file-icons', 'file.svg');
            if (fs.existsSync(defaultIconPath)) {
              const iconUri = this._view!.webview.asWebviewUri(vscode.Uri.file(defaultIconPath));
              fileIcons[filePath] = iconUri.toString();
            }
          }
        } catch (error) {
          console.error(`Error loading icon for ${filePath}:`, error);
        }
      });
      
      // Bookmarksのファイルアイコンも生成
      Object.keys(bookmarksWithContent).forEach(filePath => {
        // 既に生成済みの場合はスキップ
        if (fileIcons[filePath]) return;
        
        const iconName = this.getMaterialIconName(filePath);
        const iconPath = path.join(this.context.extensionPath, 'resources', 'file-icons', `${iconName}.svg`);
        
        try {
          if (fs.existsSync(iconPath)) {
            const iconUri = this._view!.webview.asWebviewUri(vscode.Uri.file(iconPath));
            fileIcons[filePath] = iconUri.toString();
          } else {
            // フォールバック: デフォルトのfileアイコン
            const defaultIconPath = path.join(this.context.extensionPath, 'resources', 'file-icons', 'file.svg');
            if (fs.existsSync(defaultIconPath)) {
              const iconUri = this._view!.webview.asWebviewUri(vscode.Uri.file(defaultIconPath));
              fileIcons[filePath] = iconUri.toString();
            }
          }
        } catch (error) {
          console.error(`Error loading icon for ${filePath}:`, error);
        }
      });
      
      // 設定値を取得
      const config = vscode.workspace.getConfiguration('core-anchor');
      const defaultPathType = config.get<string>('favorites.defaultPathType', 'relative');
      const showBookmarkTooltip = config.get<boolean>('bookmarks.showTooltip', true);
      const favoritesDefaultExpandState = config.get<string>('favorites.defaultExpandState', 'collapsed');
      const bookmarksDefaultExpandState = config.get<string>('bookmarks.defaultExpandState', 'collapsed');
      
      this._view.webview.postMessage({
        command: 'update',
        favorites: favorites,
        bookmarks: bookmarksWithContent,
        favoritesMeta: favoritesMeta,
        bookmarksMeta: bookmarksMeta,
        fileIcons: fileIcons,
        settings: {
          defaultPathType: defaultPathType,
          showBookmarkTooltip: showBookmarkTooltip,
          favoritesDefaultExpandState: favoritesDefaultExpandState,
          bookmarksDefaultExpandState: bookmarksDefaultExpandState,
          bookmarksGlobalSortType: bookmarksMeta.globalSortType || 'line'
        }
      });
    }
  }
}
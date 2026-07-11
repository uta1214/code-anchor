// メインロジック（完全版 - キーボードショートカット追加）

const vscode = acquireVsCodeApi();
const expandedFolders = new Set();
const expandedFiles = new Set();
let iconPaths = {};
let currentFavoriteMode = 'global';
let favoritesMeta = { folderOrder: [], fileOrder: {} };
let bookmarksMeta = { fileOrder: [], bookmarkSortType: {} };
let sectionCollapsed = { favorites: false, bookmarks: false };
let fileIcons = {}; // グローバル変数として宣言
let settings = { defaultPathType: 'relative', showBookmarkTooltip: true }; // 設定値
const ICON_LABELS = {
  'default': 'Default',
  'todo': 'TODO',
  'bug': 'Bug',
  'note': 'Note',
  'important': 'Important',
  'question': 'Question',
  'all': 'All'
};

// iconPathsとICON_LABELSをグローバルスコープに公開（ui.jsから参照できるようにする）
window.iconPaths = iconPaths;
window.ICON_LABELS = ICON_LABELS;

function loadState() {
  const state = vscode.getState();
  if (state) {
    if (state.expandedFolders) state.expandedFolders.forEach(id => expandedFolders.add(id));
    if (state.expandedFiles) state.expandedFiles.forEach(id => expandedFiles.add(id));
    if (state.iconPaths) {
      iconPaths = state.iconPaths;
      window.iconPaths = iconPaths; // グローバルスコープを更新
    }
    if (state.favoriteMode) currentFavoriteMode = state.favoriteMode;
    if (state.sectionCollapsed) {
      sectionCollapsed = state.sectionCollapsed;
    }
  }
  updateModeButtons();
  updateSectionCollapseStates();
  
  // iconPathsが存在する場合はsetIconImagesを呼ぶ
  if (iconPaths && Object.keys(iconPaths).length > 0) {
    if (typeof setIconImages === 'function') {
      setIconImages();
    }
  }
}

function saveState() {
  vscode.setState({ 
    expandedFolders: Array.from(expandedFolders), 
    expandedFiles: Array.from(expandedFiles), 
    iconPaths: iconPaths,
    favoriteMode: currentFavoriteMode,
    sectionCollapsed: sectionCollapsed
  });
}

function toggleSection(sectionName) {
  sectionCollapsed[sectionName] = !sectionCollapsed[sectionName];
  updateSectionCollapseState(sectionName);
  saveState();
}

function updateSectionCollapseState(sectionName) {
  const content = document.getElementById(sectionName + 'Content');
  const icon = document.getElementById(sectionName + 'CollapseIcon');
  
  if (content && icon) {
    if (sectionCollapsed[sectionName]) {
      content.style.display = 'none';
      icon.textContent = '▶';
    } else {
      content.style.display = 'block';
      icon.textContent = '▼';
    }
  }
}

function updateSectionCollapseStates() {
  updateSectionCollapseState('favorites');
  updateSectionCollapseState('bookmarks');
}

function updateSectionVisibility(showFavorites, showBookmarks) {
  const favoritesSection = document.getElementById('favoritesSection');
  const bookmarksSection = document.getElementById('bookmarksSection');
  const separator = document.querySelector('.separator');
  
  if (favoritesSection) {
    favoritesSection.style.display = showFavorites ? 'block' : 'none';
  }
  if (bookmarksSection) {
    bookmarksSection.style.display = showBookmarks ? 'block' : 'none';
  }
  if (separator) {
    separator.style.display = (showFavorites && showBookmarks) ? 'block' : 'none';
  }
}

// キーボードイベントハンドラ（新規追加）
window.addEventListener('keydown', (e) => {
  // Delete: 削除
  if (e.key === 'Delete') {
    e.preventDefault();
    if (typeof selectedFolderId !== 'undefined' && selectedFolderId) {
      if (typeof deleteVirtualFolder === 'function') {
        deleteVirtualFolder(selectedFolderId);
      }
    } else if (typeof selectedItemPath !== 'undefined' && selectedItemPath) {
      if (typeof removeFavorite === 'function') {
        removeFavorite(selectedItemPath);
      }
    }
    return;
  }
  
  // Escape: 各種キャンセル・クリア処理
  if (e.key === 'Escape') {
    handleEscapeKey(e);
  }
});

function handleEscapeKey(e) {
  // 検索ボックスにフォーカスがある場合のみクリア
  const favoriteSearch = document.getElementById('favoriteSearch');
  if (favoriteSearch && document.activeElement === favoriteSearch) {
    favoriteSearch.value = '';
    if (typeof filterFavorites === 'function') {
      filterFavorites();
    }
    favoriteSearch.blur();
    e.preventDefault();
    return;
  }
  
  const bookmarkSearch = document.getElementById('bookmarkSearch');
  if (bookmarkSearch && document.activeElement === bookmarkSearch) {
    bookmarkSearch.value = '';
    if (typeof filterBookmarks === 'function') {
      filterBookmarks();
    }
    bookmarkSearch.blur();
    e.preventDefault();
    return;
  }
  
  // 追加フォーム（新規作成）にフォーカスがある場合のみ、ui.jsに任せる
  // 編集フォーム（.edit-form）の場合は、このまま下の処理で閉じる
  const favoriteForm = document.getElementById('favoriteForm');
  const bookmarkForm = document.getElementById('bookmarkForm');
  
  // e.targetが編集フォーム内の要素かチェック
  const isInEditForm = e.target.closest('.edit-form.active');
  
  // 新規作成フォームにフォーカスがあり、かつ編集フォーム内でない場合のみreturn
  if (!isInEditForm && 
      ((favoriteForm && favoriteForm.classList.contains('active') && e.target.closest('#favoriteForm')) ||
       (bookmarkForm && bookmarkForm.classList.contains('active') && e.target.closest('#bookmarkForm')))) {
    return; // ui.jsのハンドラに任せる
  }
  
  // それ以外の場合: 開いている編集フォーム/編集モードをすべて閉じる
  let handled = false;
  
  // フォルダリネーム中（最優先でチェック）
  if (typeof editingFolderId !== 'undefined' && editingFolderId) {
    if (typeof cancelFolderRename === 'function') {
      cancelFolderRename();
      handled = true;
      e.preventDefault();
    }
  }
  
  // サブフォルダ作成中
  if (!handled && typeof creatingSubfolderForId !== 'undefined' && creatingSubfolderForId) {
    if (typeof cancelSubfolderCreation === 'function') {
      cancelSubfolderCreation();
      handled = true;
      e.preventDefault();
    }
  }
  
  // ファイル編集中（グローバル変数でチェック）
  if (!handled && typeof editingFavorite !== 'undefined' && editingFavorite) {
    if (typeof cancelEditFavorite === 'function') {
      cancelEditFavorite(editingFavorite);
      handled = true;
      e.preventDefault();
    }
  }
  
  // ブックマーク編集中（グローバル変数でチェック）
  if (!handled && typeof editingBookmark !== 'undefined' && editingBookmark) {
    const [filePath, line] = editingBookmark.split(':');
    if (typeof cancelEditBookmark === 'function') {
      cancelEditBookmark(filePath, parseInt(line));
      handled = true;
      e.preventDefault();
    }
  }
  
  // 編集フォームが開いている場合（念のためDOMでもチェック）
  if (!handled) {
    const activeEditForm = document.querySelector('.edit-form.active');
    if (activeEditForm) {
      const formId = activeEditForm.id;
      
      if (formId.startsWith('edit-fav-')) {
        const encodedPath = formId.replace('edit-fav-', '');
        const path = decodeURIComponent(encodedPath.replace('id-', '').replace(/_/g, '%'));
        if (typeof cancelEditFavorite === 'function') {
          cancelEditFavorite(path);
          handled = true;
        }
      } else if (formId.startsWith('edit-bm-')) {
        if (typeof editingBookmark !== 'undefined' && editingBookmark) {
          const [filePath, line] = editingBookmark.split(':');
          if (typeof cancelEditBookmark === 'function') {
            cancelEditBookmark(filePath, parseInt(line));
            handled = true;
          }
        }
      }
    }
  }
  
  if (handled) {
    e.preventDefault();
  }
}

// ページ読み込み完了後にバックエンドへ準備完了を通知する。
// 'load' イベントのみ使用し、'DOMContentLoaded' との二重送信を防ぐ。
window.addEventListener('load', () => { 
  loadState(); 
  vscode.postMessage({ command: 'ready' }); 
});

window.addEventListener('message', event => {
  const msg = event.data;
  
  if (msg.command === 'update') {
    favoritesMeta = msg.favoritesMeta || { folderOrder: [], fileOrder: {}, virtualFolders: [] };
    bookmarksMeta = msg.bookmarksMeta || { fileOrder: [], bookmarkSortType: {} };
    allFavoritesData = msg.favorites;
    allBookmarksData = msg.bookmarks;
    
    // favorites.js からアクセスできるように window に公開
    window.favoritesMeta = favoritesMeta;
    
    // 設定値を更新
    if (msg.settings) {
      settings = msg.settings;
      
      // bookmarks.js に初期開閉状態を渡す
      if (typeof bookmarksDefaultExpandState !== 'undefined' && msg.settings.bookmarksDefaultExpandState) {
        bookmarksDefaultExpandState = msg.settings.bookmarksDefaultExpandState;
      }
      
      // favorites.js にも初期開閉状態を渡す（変数名は同じだがスコープが異なる）
      // グローバルスコープに設定してfavorites.jsからも参照できるようにする
      if (msg.settings.favoritesDefaultExpandState) {
        window.favoritesDefaultExpandState = msg.settings.favoritesDefaultExpandState;
      }

      // ブックマークのグローバルソートタイプを更新
      if (typeof globalBookmarkSortType !== 'undefined' && msg.settings.bookmarksGlobalSortType) {
        globalBookmarkSortType = msg.settings.bookmarksGlobalSortType;
        if (typeof updateGlobalSortButtons === 'function') {
          updateGlobalSortButtons();
        }
      }
    }
    
    // 仮想フォルダ情報を更新
    if (typeof virtualFolders !== 'undefined') {
      virtualFolders = favoritesMeta.virtualFolders || [];
      if (typeof updateVirtualFolderSelect === 'function') {
        updateVirtualFolderSelect();
      }
    }
    
    // ファイルアイコンのマッピングを更新
    if (msg.fileIcons) {
      fileIcons = msg.fileIcons;
    }
    
    if (typeof updateFavorites === 'function') {
      updateFavorites(msg.favorites);
    }
    if (typeof updateBookmarks === 'function') {
      updateBookmarks(msg.bookmarks);
    }
  } else if (msg.command === 'setIconPaths') {
    iconPaths = msg.paths;
    window.iconPaths = iconPaths; // グローバルスコープを更新
    saveState();
    
    // setIconImagesを呼んでドロップダウンの選択肢を生成
    if (typeof setIconImages === 'function') {
      setIconImages();
    } else {
      console.error('[main.js] setIconImages is not defined!');
    }
    
    // アイコンパスが更新されたらブックマークを再描画
    if (typeof updateBookmarks === 'function' && allBookmarksData) {
      updateBookmarks(allBookmarksData);
    }
  } else if (msg.command === 'setFavoriteMode') {
    currentFavoriteMode = msg.mode;
    updateModeButtons();
    saveState();
  } else if (msg.command === 'setSectionVisibility') {
    updateSectionVisibility(msg.showFavorites, msg.showBookmarks);
  } else if (msg.command === 'openAddFileForm') {
    // ファイル追加フォームを開き、ファイルパスをプリフィル
    const form = document.getElementById('favoriteForm');
    const filePathInput = document.getElementById('filePath');
    const fileIsRelativeCheckbox = document.getElementById('fileIsRelative');
    
    if (form && filePathInput) {
      filePathInput.value = msg.filePath || '';
      form.classList.add('active');
      
      // 設定値に基づいてチェックボックスを設定
      if (fileIsRelativeCheckbox) {
        fileIsRelativeCheckbox.checked = settings.defaultPathType === 'relative';
      }
      
      // フォームをスクロール
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      });
      
      // フォーカスを設定
      setTimeout(() => {
        if (msg.filePath) {
          // パスがプリフィルされている場合は説明欄にフォーカス
          document.getElementById('fileDesc')?.focus();
        } else {
          // パスが空の場合はパス入力欄にフォーカス
          filePathInput.focus();
        }
      }, 50);
    }
  } else if (msg.command === 'openAddBookmarkForm') {
    // ブックマーク追加フォームを開き、ファイルパスとカーソル行をプリフィル
    const form = document.getElementById('bookmarkForm');
    const fileInput = document.getElementById('bookmarkFile');
    const lineInput = document.getElementById('bookmarkLine');
    const labelInput = document.getElementById('bookmarkLabel');

    if (form && fileInput && lineInput) {
      // 他の開いているフォーム・編集フォームを閉じる
      document.querySelectorAll('.add-form.active').forEach(f => {
        if (f.id !== 'bookmarkForm') f.classList.remove('active');
      });
      document.querySelectorAll('.edit-form.active').forEach(f => f.classList.remove('active'));

      // 値をセット
      fileInput.value = msg.filePath || '';
      lineInput.value = msg.lineNumber != null ? String(msg.lineNumber) : '';

      // フォームを開く
      form.classList.add('active');

      // フォームをスクロール
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      });

      // フォーカスを設定:
      //   ファイルパスも行番号もプリフィルされている → ラベル入力欄へ
      //   ファイルパスのみ → 行番号入力欄へ
      //   どちらも空 → ファイルパス入力欄へ
      setTimeout(() => {
        if (msg.filePath && msg.lineNumber != null) {
          labelInput?.focus();
        } else if (msg.filePath) {
          lineInput.focus();
        } else {
          fileInput.focus();
        }
      }, 50);
    }
  } else if (msg.command === 'setHighlightedBookmark') {
    // ブックマークをハイライト
    if (typeof highlightedBookmark !== 'undefined') {
      highlightedBookmark = { filePath: msg.filePath, line: msg.line };
      
      // ファイルグループが閉じていたら自動展開
      const fileId = safeId(msg.filePath);
      const fileItems = document.getElementById('fileitems-' + fileId);
      if (fileItems && !fileItems.classList.contains('expanded')) {
        toggleFileGroup(fileId);
      }
      
      // 再描画してハイライト適用
      if (typeof updateBookmarks === 'function' && allBookmarksData) {
        updateBookmarks(allBookmarksData);
      }
    }
  }
});

// グローバルに公開
window.toggleSection = toggleSection;
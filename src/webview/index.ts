import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

// 🔧 FIX(security): Webview に Content-Security-Policy を設定する（多層防御）。
// 現状スクリプトは全てこの拡張機能自身が生成するインライン<script>のみなので、
// nonce を都度発行して script-src をそのnonceだけに限定する。
function getNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

export function getHtmlContent(webview: vscode.Webview): string {
  const htmlPath = path.join(__dirname, 'template.html');
  const uiJsPath = path.join(__dirname, 'scripts', 'ui.js');
  const favoritesJsPath = path.join(__dirname, 'scripts', 'favorites.js');
  const bookmarksJsPath = path.join(__dirname, 'scripts', 'bookmarks.js');
  const mainJsPath = path.join(__dirname, 'scripts', 'main.js');

  // テーマ設定を取得
  const config = vscode.workspace.getConfiguration('core-anchor');
  const theme = config.get<string>('ui.theme', 'classic');
  
  // テーマに応じたCSSファイルを選択
  const cssFileName = `styles-${theme}.css`;
  const cssPath = path.join(__dirname, cssFileName);

  const html = fs.readFileSync(htmlPath, 'utf-8');
  const css = fs.readFileSync(cssPath, 'utf-8');
  const uiJs = fs.readFileSync(uiJsPath, 'utf-8');
  const favoritesJs = fs.readFileSync(favoritesJsPath, 'utf-8');
  const bookmarksJs = fs.readFileSync(bookmarksJsPath, 'utf-8');
  const mainJs = fs.readFileSync(mainJsPath, 'utf-8');

  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    // style属性やCSS変数を多用しているため style-src は 'unsafe-inline' を許容する
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return html
    .replace('<!-- CSP_PLACEHOLDER -->', `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace('<!-- CSS_PLACEHOLDER -->', `<style>${css}</style>`)
    .replace('<!-- SCRIPT_PLACEHOLDER -->', `
      <script nonce="${nonce}">
        ${uiJs}
        ${favoritesJs}
        ${bookmarksJs}
        ${mainJs}
      </script>
  `);
}
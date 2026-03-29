#!/usr/bin/env node
/**
 * MoldMainte v1.0.1 パッチスクリプト
 * 
 * スマホ版マスタ画面（機械/ライン/ユーザー）にカード表示を追加
 * 
 * 使い方:
 *   node patch_v1.0.1.js index.html
 *   → index_patched.html が出力される
 */

const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2] || 'index.html';
const outputFile = process.argv[3] || inputFile.replace('.html', '_patched.html');

if (!fs.existsSync(inputFile)) {
  console.error(`エラー: ${inputFile} が見つかりません`);
  process.exit(1);
}

let content = fs.readFileSync(inputFile, 'utf-8');
let patchCount = 0;

// ===== PATCH 1: renderMasterMachines にスマホ用カード追加 =====
const old1 = `  </table></div>\`;
}

function renderMasterLines(el) {`;

const new1 = `  </table></div>
  <div class="mold-cards">\${sortMasterData(state.machines, masterSortState[masterCurrentTab]?.key||'machine_no', masterSortState[masterCurrentTab]?.dir||'asc').map(m=>{
      const line = state.lines.find(l=>l.id===m.line_id);
      return \`<div class="mold-card" style="border-left-color:\${m.is_dandori?'var(--info-text)':'var(--border)'}">
      <div class="mold-card-top"><div>
        <div class="mold-card-name">#\${esc(m.machine_no)}</div>
        <div class="mold-card-part">\${esc(line?.name||'-')} / <span class="badge \${m.is_dandori?'badge-info':'badge-gray'}">\${m.is_dandori?t('dandori'):t('fixed')}</span></div>
      </div></div>
      \${m.note?\`<div style="font-size:10px;color:var(--text3);margin-top:4px">\${esc(m.note)}</div>\`:''}
      <div style="display:flex;gap:6px;margin-top:6px">
        <button class="btn btn-secondary btn-sm" style="flex:1" onclick="editMachine('\${m.id}')">\${t('edit')}</button>
        <button class="btn btn-danger btn-sm" style="flex:1" onclick="deleteMachine('\${m.id}')">\${t('delete')}</button>
      </div>
    </div>\`;
    }).join('')}</div>\`;
}

function renderMasterLines(el) {`;

if (content.includes(old1)) {
  content = content.replace(old1, new1);
  patchCount++;
  console.log('✅ PATCH 1: renderMasterMachines - スマホ用カード追加');
} else {
  console.error('❌ PATCH 1: renderMasterMachines - 検索文字列が見つかりません');
}

// ===== PATCH 2: renderMasterLines にスマホ用カード追加 =====
const old2 = `  </table></div>\`;
}

async function renderMasterUsers(el) {`;

const new2 = `  </table></div>
  <div class="mold-cards">\${sorted.map(l=>\`
    <div class="mold-card" style="border-left-color:var(--border)">
      <div class="mold-card-top"><div>
        <div class="mold-card-name">\${esc(l.name)}</div>
        <div class="mold-card-part">\${l.machine_count}\${t('tai')}</div>
      </div></div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <button class="btn btn-secondary btn-sm" style="flex:1" onclick="editLine('\${l.id}')">\${t('edit')}</button>
      </div>
    </div>\`).join('')}</div>\`;
}

async function renderMasterUsers(el) {`;

if (content.includes(old2)) {
  content = content.replace(old2, new2);
  patchCount++;
  console.log('✅ PATCH 2: renderMasterLines - スマホ用カード追加');
} else {
  console.error('❌ PATCH 2: renderMasterLines - 検索文字列が見つかりません');
}

// ===== PATCH 3: renderMasterUsersTable にスマホ用カード追加 =====
const old3 = `    + '<div class="table-wrap"><table>' + thead + tbody + '</table></div>';
  el.querySelectorAll('.su-th').forEach(function(th) {`;

const new3 = `    + '<div class="table-wrap"><table>' + thead + tbody + '</table></div>'
    + '<div class="mold-cards">' + sorted.map(function(u) {
        var ll = u.last_login_at || u.updated_at;
        var ls = ll ? new Date(ll).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '-';
        var roleBadge = u.role === 'admin' ? '<span class="badge badge-warning">\\u7ba1\\u7406\\u8005</span>' : '<span class="badge badge-gray">\\u4f5c\\u696d\\u8005</span>';
        return '<div class="mold-card" style="border-left-color:' + (u.role==='admin' ? 'var(--warning)' : 'var(--border)') + '">'
          + '<div class="mold-card-top"><div>'
          + '<div class="mold-card-name">' + esc(u.name||'') + '</div>'
          + '<div class="mold-card-part">' + roleBadge + '  ' + ls + '</div>'
          + '</div></div>'
          + '<div style="display:flex;gap:6px;margin-top:6px">'
          + '<button class="btn btn-secondary btn-sm" style="flex:1" data-uid="' + (u.id||'') + '" onclick="editUser(this.getAttribute(\\'data-uid\\'))">' + t('edit') + '</button>'
          + '<button class="btn btn-danger btn-sm" style="flex:1" data-uid="' + (u.id||'') + '" data-uname="' + esc(u.name||'').replace(/"/g,'') + '" onclick="(function(b){var uid=b.getAttribute(\\'data-uid\\');var nm=b.getAttribute(\\'data-uname\\')||\\' ?\\';if(confirm(nm+\\' ' + t('deleteConfirm') + '\\')){deleteUser(uid);}})(this)">' + t('delete') + '</button>'
          + '</div></div>';
      }).join('') + '</div>';
  el.querySelectorAll('.su-th').forEach(function(th) {`;

if (content.includes(old3)) {
  content = content.replace(old3, new3);
  patchCount++;
  console.log('✅ PATCH 3: renderMasterUsersTable - スマホ用カード追加');
} else {
  console.error('❌ PATCH 3: renderMasterUsersTable - 検索文字列が見つかりません');
}

// ===== バージョン更新 =====
const oldVer = "const CURRENT_VERSION = '1.0.0';";
const newVer = "const CURRENT_VERSION = '1.0.1';";
if (content.includes(oldVer)) {
  content = content.replace(oldVer, newVer);
  console.log('✅ VERSION: 1.0.0 → 1.0.1');
}

const oldMetaVer = '<meta name="app-version" content="1.0.0">';
const newMetaVer = '<meta name="app-version" content="1.0.1">';
if (content.includes(oldMetaVer)) {
  content = content.replace(oldMetaVer, newMetaVer);
  console.log('✅ META VERSION: 1.0.0 → 1.0.1');
}

// ===== 結果出力 =====
console.log(`\n━━━ 結果: ${patchCount}/3 パッチ適用 ━━━`);

if (patchCount === 3) {
  fs.writeFileSync(outputFile, content, 'utf-8');
  console.log(`\n✅ 完了: ${outputFile} に保存しました`);
  console.log(`   → このファイルをGitHub Pagesにアップロードしてください`);
} else {
  console.error('\n❌ 一部のパッチが適用できませんでした');
  console.error('   元のindex.htmlが想定と異なる可能性があります');
  process.exit(1);
}

/**
 * Full local test: simulates the workspaces API and tabs API
 * to verify all chats across all projects are accessible.
 * Matches updated route.ts logic (full-path + folder-name matching).
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const wsPath = path.join(process.env.APPDATA, 'Cursor/User/workspaceStorage');
const globalDbPath = path.join(process.env.APPDATA, 'Cursor/User/globalStorage/state.vscdb');

// === STEP 1: Build workspace entries (same as route.ts) ===
const dirs = fs.readdirSync(wsPath).filter(d => fs.statSync(path.join(wsPath, d)).isDirectory());
const workspaceEntries = [];
for (const d of dirs) {
  const wjPath = path.join(wsPath, d, 'workspace.json');
  if (fs.existsSync(wjPath)) {
    workspaceEntries.push({ name: d, workspaceJsonPath: wjPath });
  }
}

function normalizeFilePath(filePath) {
  let normalized = filePath.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
  try { normalized = decodeURIComponent(normalized); } catch(e) {}
  normalized = normalized.replace(/\//g, '\\');
  normalized = normalized.replace(/^\\([a-z]:)/i, '$1');
  normalized = normalized.toLowerCase();
  return normalized;
}

function getProjectFromFilePath(filePath) {
  const normalizedPath = normalizeFilePath(filePath);
  let bestMatch = null;
  let bestLen = 0;
  for (const entry of workspaceEntries) {
    try {
      const workspaceData = JSON.parse(fs.readFileSync(entry.workspaceJsonPath, 'utf-8'));
      if (workspaceData.folder) {
        const workspacePath = normalizeFilePath(workspaceData.folder);
        if (normalizedPath.startsWith(workspacePath) && workspacePath.length > bestLen) {
          bestLen = workspacePath.length;
          bestMatch = entry.name;
        }
      }
    } catch (e) {}
  }
  return bestMatch;
}

// Build project name -> workspace ID map (folder name matching)
const projectNameToWorkspaceId = {};
for (const entry of workspaceEntries) {
  try {
    const data = JSON.parse(fs.readFileSync(entry.workspaceJsonPath, 'utf-8'));
    if (data.folder) {
      const folderName = data.folder.split('/').pop() || data.folder.split('\\').pop();
      if (folderName) projectNameToWorkspaceId[folderName] = entry.name;
    }
  } catch (e) {}
}

// Build full-path -> workspace ID map (updated matching from route.ts)
const workspacePathToId = {};
for (const entry of workspaceEntries) {
  try {
    const data = JSON.parse(fs.readFileSync(entry.workspaceJsonPath, 'utf-8'));
    if (data.folder) {
      const normalized = normalizeFilePath(data.folder);
      workspacePathToId[normalized] = entry.name;
    }
  } catch (e) {}
}

// === STEP 2: Read global DB ===
const db = new Database(globalDbPath, { readonly: true });

// Get all composerData
const composerRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND LENGTH(value) > 10").all();

// Get messageRequestContext for projectLayouts
const messageContextRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'messageRequestContext:%'").all();
const projectLayoutsMap = {};
for (const row of messageContextRows) {
  const parts = row.key.split(':');
  if (parts.length >= 2) {
    const composerId = parts[1];
    try {
      const context = JSON.parse(row.value);
      if (context && context.projectLayouts && Array.isArray(context.projectLayouts)) {
        if (!projectLayoutsMap[composerId]) projectLayoutsMap[composerId] = [];
        for (const layout of context.projectLayouts) {
          if (typeof layout === 'string') {
            try {
              const obj = JSON.parse(layout);
              if (obj.rootPath) projectLayoutsMap[composerId].push(obj.rootPath);
            } catch(e) {}
          }
        }
      }
    } catch(e) {}
  }
}

// Get all bubbles for matching
const bubbleRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").all();
const bubbleMap = {};
for (const row of bubbleRows) {
  const bubbleId = row.key.split(':')[2];
  try {
    const bubble = JSON.parse(row.value);
    if (bubble && typeof bubble === 'object') bubbleMap[bubbleId] = bubble;
  } catch(e) {}
}

// === STEP 3: Map each composer to a workspace (updated logic) ===
function determineProject(composerData, composerId) {
  // Try projectLayouts first (full-path matching, then folder-name fallback)
  const layouts = projectLayoutsMap[composerId] || [];
  for (const rootPath of layouts) {
    const normalized = normalizeFilePath(rootPath);
    let wsId = workspacePathToId[normalized];
    if (!wsId) {
      const folderName = rootPath.split('/').pop() || rootPath.split('\\').pop();
      wsId = folderName ? projectNameToWorkspaceId[folderName] : undefined;
    }
    if (wsId) return wsId;
  }

  // Also check workspaceUris stored directly on bubbles
  const headers = composerData.fullConversationHeadersOnly || [];
  for (const h of headers) {
    const bubble = bubbleMap[h.bubbleId];
    if (bubble && bubble.workspaceUris && Array.isArray(bubble.workspaceUris)) {
      for (const uri of bubble.workspaceUris) {
        if (uri) {
          const uriStr = typeof uri === 'string' ? uri : (uri.path || uri.fsPath || '');
          if (uriStr) {
            const pid = getProjectFromFilePath(uriStr);
            if (pid) return pid;
          }
        }
      }
    }
  }

  // Try newlyCreatedFiles
  if (composerData.newlyCreatedFiles && composerData.newlyCreatedFiles.length > 0) {
    for (const file of composerData.newlyCreatedFiles) {
      if (file.uri && file.uri.path) {
        const pid = getProjectFromFilePath(file.uri.path);
        if (pid) return pid;
      }
    }
  }
  // Try codeBlockData
  if (composerData.codeBlockData) {
    for (const fp of Object.keys(composerData.codeBlockData)) {
      const pid = getProjectFromFilePath(fp.replace('file://', ''));
      if (pid) return pid;
    }
  }
  // Try bubble file references
  for (const header of headers) {
    const bubble = bubbleMap[header.bubbleId];
    if (bubble) {
      if (bubble.relevantFiles && Array.isArray(bubble.relevantFiles)) {
        for (const fp of bubble.relevantFiles) {
          if (fp) { const pid = getProjectFromFilePath(fp); if (pid) return pid; }
        }
      }
      if (bubble.context && bubble.context.fileSelections && Array.isArray(bubble.context.fileSelections)) {
        for (const sel of bubble.context.fileSelections) {
          if (sel && sel.uri && sel.uri.path) { const pid = getProjectFromFilePath(sel.uri.path); if (pid) return pid; }
        }
      }
    }
  }
  return null;
}

const conversationMap = {};
for (const row of composerRows) {
  const composerId = row.key.split(':')[1];
  try {
    const data = JSON.parse(row.value);
    const projectId = determineProject(data, composerId) || 'global';
    if (!conversationMap[projectId]) conversationMap[projectId] = [];

    // Count messages
    const headers = data.fullConversationHeadersOnly || [];
    let messageCount = 0;
    for (const h of headers) {
      if (bubbleMap[h.bubbleId]) messageCount++;
    }

    conversationMap[projectId].push({
      composerId,
      name: data.name || 'Conversation ' + composerId.slice(0, 8),
      messageCount,
      headerCount: headers.length,
      isAgentic: data.isAgentic || false,
      status: data.status || 'unknown',
      createdAt: data.createdAt,
      lastUpdatedAt: data.lastUpdatedAt
    });
  } catch(e) {}
}

// === STEP 4: Build workspace list with names ===
const workspaceNames = {};
for (const entry of workspaceEntries) {
  try {
    const data = JSON.parse(fs.readFileSync(entry.workspaceJsonPath, 'utf-8'));
    if (data.folder) {
      const folderName = data.folder.split('/').pop() || data.folder.split('\\').pop();
      workspaceNames[entry.name] = folderName || entry.name.slice(0, 8);
    }
  } catch(e) { workspaceNames[entry.name] = entry.name.slice(0, 8); }
}
workspaceNames['global'] = 'Global / Unmatched';

// === OUTPUT ===
console.log('='.repeat(80));
console.log('CURSOR CHAT BROWSER — LOCAL TEST');
console.log('='.repeat(80));
console.log('');
console.log('Database: ' + globalDbPath);
console.log('Total composerData entries: ' + composerRows.length);
console.log('Total bubbleId entries: ' + bubbleRows.length);
console.log('Total workspace dirs: ' + workspaceEntries.length);
console.log('messageRequestContext entries: ' + messageContextRows.length);
console.log('Composers with projectLayouts: ' + Object.keys(projectLayoutsMap).length);
console.log('');

// Show all workspaces with conversations
const allWorkspaceIds = Object.keys(conversationMap).sort((a, b) => {
  return (conversationMap[b].length) - (conversationMap[a].length);
});

console.log('─'.repeat(80));
console.log('WORKSPACES WITH CONVERSATIONS');
console.log('─'.repeat(80));

let totalConversations = 0;
let totalMessages = 0;

for (const wsId of allWorkspaceIds) {
  const convs = conversationMap[wsId];
  const wsName = workspaceNames[wsId] || wsId.slice(0, 8);
  console.log('');
  console.log('>> ' + wsName + ' (' + convs.length + ' conversations)');
  console.log('   Workspace ID: ' + wsId);
  console.log('');

  // Sort by lastUpdatedAt descending
  convs.sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));

  for (let i = 0; i < convs.length; i++) {
    const c = convs[i];
    const created = c.createdAt ? new Date(c.createdAt).toLocaleString() : 'unknown';
    const updated = c.lastUpdatedAt ? new Date(c.lastUpdatedAt).toLocaleString() : 'unknown';
    const title = c.name.length > 70 ? c.name.slice(0, 67) + '...' : c.name;
    console.log('   ' + (i+1) + '. "' + title + '"');
    console.log('      Messages: ' + c.messageCount + ' | Agentic: ' + c.isAgentic + ' | Status: ' + c.status);
    console.log('      Created: ' + created + ' | Updated: ' + updated);
    totalMessages += c.messageCount;
  }
  totalConversations += convs.length;
}

console.log('');
console.log('─'.repeat(80));
console.log('WORKSPACES WITHOUT CONVERSATIONS (' + (workspaceEntries.length - (allWorkspaceIds.length - (conversationMap['global'] ? 1 : 0))) + ')');
console.log('─'.repeat(80));

let emptyCount = 0;
for (const entry of workspaceEntries) {
  if (!conversationMap[entry.name]) {
    const wsName = workspaceNames[entry.name] || entry.name.slice(0, 8);
    if (emptyCount < 10) console.log('   ' + wsName);
    emptyCount++;
  }
}
if (emptyCount > 10) console.log('   ... and ' + (emptyCount - 10) + ' more');

console.log('');
console.log('─'.repeat(80));
console.log('SAMPLE CONVERSATION DETAIL');
console.log('─'.repeat(80));

// Show detail for one conversation from each workspace that has them
for (const wsId of allWorkspaceIds) {
  const convs = conversationMap[wsId];
  const wsName = workspaceNames[wsId] || wsId;
  // Pick the conversation with the most messages
  const best = convs.reduce((a, b) => (a.messageCount > b.messageCount ? a : b));
  if (best.messageCount === 0) continue;

  console.log('');
  console.log('>> ' + wsName + ' — "' + best.name.slice(0, 60) + '"');

  const composerRow = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get('composerData:' + best.composerId);
  if (composerRow) {
    const composerData = JSON.parse(composerRow.value);
    const headers = composerData.fullConversationHeadersOnly || [];

    for (let i = 0; i < Math.min(headers.length, 4); i++) {
      const h = headers[i];
      const bubble = bubbleMap[h.bubbleId];
      if (bubble) {
        const isUser = h.type === 1;
        const role = isUser ? 'USER' : 'AI';
        const text = (bubble.text || '').replace(/\r?\n/g, ' ').slice(0, 120);
        const modelName = bubble.modelInfo ? bubble.modelInfo.modelName : null;

        console.log('   [' + role + ']' + (modelName ? ' model=' + modelName : '') + ': ' + (text || '(richText only)'));
      }
    }
    if (headers.length > 4) console.log('   ... +' + (headers.length - 4) + ' more messages');
  }
}

// === SUMMARY ===
console.log('');
console.log('='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
console.log('Workspaces with conversations: ' + allWorkspaceIds.length);
console.log('  - Matched to projects: ' + (allWorkspaceIds.filter(id => id !== 'global').length));
console.log('  - Global / Unmatched: ' + (conversationMap['global'] ? 1 : 0));
console.log('Workspaces without conversations: ' + emptyCount);
console.log('Total conversations: ' + totalConversations);
console.log('  - In named projects: ' + (totalConversations - (conversationMap['global'] || []).length));
console.log('  - In Global / Unmatched: ' + (conversationMap['global'] || []).length);
console.log('Total messages (with bubble data): ' + totalMessages);
console.log('');
console.log('VERIFICATION: DB has ' + composerRows.length + ' composers, mapped ' + totalConversations + ' = ' + (composerRows.length === totalConversations ? 'ALL ACCOUNTED FOR' : 'MISMATCH'));

db.close();

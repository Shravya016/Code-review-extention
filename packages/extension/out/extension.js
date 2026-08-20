"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const child_process_1 = require("child_process");
const util_1 = require("util");
const DIAG_COLLECTION = "codereview-findings";
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
function decodeCommandArgs(encodedArgs) {
    try {
        const decoded = decodeURIComponent(encodedArgs);
        const parsed = JSON.parse(decoded);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function parseReportActionFromLine(line) {
    const accept = line.match(/command:codereview\.applyFixFromReport\?([^\s)]+)/);
    if (accept?.[1]) {
        return { command: "codereview.applyFixFromReport", args: decodeCommandArgs(accept[1]) };
    }
    const gen = line.match(/command:codereview\.generateFixFromReport\?([^\s)]+)/);
    if (gen?.[1]) {
        return { command: "codereview.generateFixFromReport", args: decodeCommandArgs(gen[1]) };
    }
    const rej = line.match(/command:codereview\.rejectFindingFromReport\?([^\s)]+)/);
    if (rej?.[1]) {
        return { command: "codereview.rejectFindingFromReport", args: decodeCommandArgs(rej[1]) };
    }
    return undefined;
}
function parseActionMarker(line, lineIdx) {
    const m = line.match(/<!--\s*codereview:actions\s+([^>]+?)\s*-->/);
    if (!m) {
        return undefined;
    }
    const attrs = {};
    const re = /([a-zA-Z]+)=("[^"]*"|\S+)/g;
    let match;
    while ((match = re.exec(m[1])) !== null) {
        const key = match[1];
        const raw = match[2];
        attrs[key] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
    }
    const docUri = attrs.docUri;
    const idx = Number.parseInt(attrs.idx ?? "", 10);
    if (!docUri || !Number.isFinite(idx)) {
        return undefined;
    }
    return {
        line: lineIdx,
        docUri,
        index: idx,
        sidecarUri: attrs.sidecarUri,
        hasFix: attrs.hasFix === "true",
        sourcePath: attrs.source,
    };
}
class FindingsReportCodeLensProvider {
    provideCodeLenses(document) {
        const lenses = [];
        if (!document.fileName.toLowerCase().endsWith(".findings.md")) {
            return lenses;
        }
        let topDocUri;
        for (let i = 0; i < document.lineCount; i += 1) {
            const line = document.lineAt(i).text;
            const marker = parseActionMarker(line, i);
            if (!marker) {
                continue;
            }
            if (!topDocUri) {
                topDocUri = marker.docUri;
            }
            const range = new vscode.Range(i, 0, i, line.length);
            const callArgs = [marker.docUri, marker.index, marker.sidecarUri ?? ""];
            lenses.push(new vscode.CodeLens(range, {
                title: marker.hasFix ? "$(check) Apply Fix" : "$(check) Apply Fix (generate)",
                command: "codereview.applyFixFromReport",
                arguments: callArgs,
            }));
            lenses.push(new vscode.CodeLens(range, {
                title: "$(sparkle) Generate Fix",
                command: "codereview.generateFixFromReport",
                arguments: callArgs,
            }));
            lenses.push(new vscode.CodeLens(range, {
                title: "$(close) Reject",
                command: "codereview.rejectFindingFromReport",
                arguments: callArgs,
            }));
        }
        if (topDocUri) {
            const topRange = new vscode.Range(0, 0, 0, document.lineAt(0).text.length);
            lenses.push(new vscode.CodeLens(topRange, {
                title: "$(zap) Apply All Fixes",
                command: "codereview.applyAllFixesFromReport",
                arguments: [topDocUri],
            }));
            lenses.push(new vscode.CodeLens(topRange, {
                title: "$(refresh) Review Again",
                command: "codereview.reviewFromReport",
                arguments: [topDocUri],
            }));
            lenses.push(new vscode.CodeLens(topRange, {
                title: "$(file-code) Open Source File",
                command: "codereview.openSourceFromReport",
                arguments: [topDocUri],
            }));
        }
        return lenses;
    }
}
class ReportPanel {
    panel;
    static current;
    disposables = [];
    currentHandler;
    static createOrShow(context, state, onMessage) {
        if (ReportPanel.current) {
            ReportPanel.current.setHandler(onMessage);
            ReportPanel.current.update(state);
            ReportPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
            return ReportPanel.current;
        }
        const panel = vscode.window.createWebviewPanel("codereview.reportPanel", "CodeReview Report", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
        ReportPanel.current = new ReportPanel(panel, onMessage);
        ReportPanel.current.update(state);
        return ReportPanel.current;
    }
    constructor(panel, onMessage) {
        this.panel = panel;
        this.currentHandler = onMessage;
        panel.onDidDispose(() => {
            ReportPanel.current = undefined;
            this.disposables.forEach((d) => d.dispose());
        }, null, this.disposables);
        panel.webview.onDidReceiveMessage(async (msg) => {
            try {
                await this.currentHandler(msg);
            }
            catch (err) {
                const m = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`CodeReview action failed: ${m}`);
            }
        }, null, this.disposables);
    }
    setHandler(onMessage) {
        this.currentHandler = onMessage;
    }
    update(state) {
        this.panel.title = `CodeReview Report - ${state.filePath.split(/[\\/]/).pop() ?? state.filePath}`;
        this.panel.webview.html = renderReportPanelHtml(state);
    }
    dispose() {
        this.panel.dispose();
    }
}
function severityClass(s) {
    switch (s.toLowerCase()) {
        case "critical":
            return "sev-critical";
        case "high":
            return "sev-high";
        case "medium":
            return "sev-medium";
        case "low":
            return "sev-low";
        default:
            return "sev-info";
    }
}
function renderReportPanelHtml(state) {
    const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const findingCards = state.findings
        .map((f, idx) => {
        const title = String(f.title || `Finding ${idx + 1}`);
        const sev = String(f.severity || "info");
        const cat = String(f.category || "quality");
        const detail = String(f.detail || "No detail provided.");
        const start = typeof f.start_line === "number" ? f.start_line : Number.parseInt(String(f.start_line || ""), 10);
        const end = typeof f.end_line === "number" ? f.end_line : Number.parseInt(String(f.end_line || start), 10);
        const validStart = Number.isFinite(start) && start > 0 ? start : undefined;
        const validEnd = Number.isFinite(end) && end >= (validStart || 1) ? end : validStart;
        const fix = sanitizeReplacementToCode(f.suggested_fix);
        const hasFix = !!fix;
        let currentCodeBlock = "";
        if (validStart && validEnd) {
            const ctxStart = Math.max(1, validStart - 1);
            const ctxEnd = Math.min(state.sourceLines.length, validEnd + 1);
            const snippetLines = [];
            for (let ln = ctxStart; ln <= ctxEnd; ln += 1) {
                const text = state.sourceLines[ln - 1] ?? "";
                const marker = ln >= validStart && ln <= validEnd ? "›" : " ";
                snippetLines.push(`${marker} ${String(ln).padStart(4, " ")} | ${text}`);
            }
            currentCodeBlock = `<div class="label">Current code (lines ${validStart}-${validEnd})</div>
<pre class="code current">${escape(snippetLines.join("\n"))}</pre>`;
        }
        const expectedCodeBlock = hasFix
            ? `<div class="label">Expected code</div>
<pre class="code expected">${escape(fix)}</pre>`
            : `<div class="label">Expected code</div>
<div class="muted">No fix generated yet. Click <strong>Generate Fix</strong> to request one.</div>`;
        return `<section class="card ${severityClass(sev)}">
<header>
  <span class="badge">${escape(sev)}</span>
  <span class="badge cat">${escape(cat)}</span>
  <h2>${idx + 1}. ${escape(title)}</h2>
</header>
<div class="meta">Line ${validStart ?? "?"}${validEnd && validEnd !== validStart ? `-${validEnd}` : ""}</div>
<div class="label">Problem</div>
<p>${escape(detail)}</p>
${currentCodeBlock}
${expectedCodeBlock}
<div class="actions">
  <button class="primary" data-action="apply" data-index="${idx}">${hasFix ? "Apply Fix" : "Apply Fix (will generate)"}</button>
  <button data-action="generate" data-index="${idx}">Generate Fix</button>
  <button data-action="reject" data-index="${idx}">Reject</button>
  <button data-action="reveal" data-index="${idx}">Go to Line</button>
</div>
</section>`;
    })
        .join("\n");
    const headerSummary = state.findings.length
        ? `${state.findings.length} finding(s)`
        : "No findings reported. Code looks clean.";
    const body = state.findings.length
        ? findingCards
        : `<div class="empty">No findings yet. Run <strong>Review Active File</strong> on a source file.</div>`;
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); }
  .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 8px; flex-wrap: wrap; }
  .top h1 { font-size: 16px; margin: 0; }
  .top .toolbar button { margin-left: 4px; }
  .summary { opacity: 0.8; font-size: 12px; margin-bottom: 16px; }
  .card { border: 1px solid var(--vscode-panel-border, #444); border-left-width: 4px; border-radius: 6px; padding: 12px 14px; margin-bottom: 14px; background: var(--vscode-editor-background); }
  .card.sev-critical { border-left-color: #d73a49; }
  .card.sev-high { border-left-color: #e36209; }
  .card.sev-medium { border-left-color: #dbab09; }
  .card.sev-low { border-left-color: #0366d6; }
  .card.sev-info { border-left-color: #6a737d; }
  .card header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
  .card h2 { font-size: 14px; margin: 0; flex: 1; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: rgba(127,127,127,0.2); text-transform: uppercase; letter-spacing: 0.5px; }
  .badge.cat { background: rgba(60,120,200,0.2); }
  .meta { font-size: 11px; opacity: 0.75; margin-bottom: 8px; }
  .label { font-weight: 600; margin-top: 10px; margin-bottom: 4px; font-size: 12px; opacity: 0.9; }
  .muted { opacity: 0.7; font-style: italic; font-size: 12px; }
  .code { background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1)); padding: 8px 10px; border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre; overflow-x: auto; }
  .code.expected { border-left: 3px solid #2ea44f; }
  .code.current { border-left: 3px solid #6a737d; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent); padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .empty { padding: 20px; text-align: center; opacity: 0.7; }
</style>
</head>
<body>
<div class="top">
  <h1>CodeReview Report - ${escape(state.filePath)}</h1>
  <div class="toolbar">
    <button class="primary" data-action="reviewAgain">Review Again</button>
    <button data-action="applyAll">Apply All Fixes</button>
    <button data-action="openSource">Open Source</button>
    <button data-action="commitPush">Commit &amp; Push</button>
  </div>
</div>
<div class="summary">${escape(headerSummary)} - Generated ${escape(state.generatedAt)}</div>
${body}
<script>
const vscode = acquireVsCodeApi();
document.querySelectorAll('button[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.getAttribute('data-action');
    const idxAttr = btn.getAttribute('data-index');
    const index = idxAttr === null ? undefined : Number.parseInt(idxAttr, 10);
    vscode.postMessage({ action, index });
  });
});
</script>
</body>
</html>`;
}
class FindingsCodeActionProvider {
    getFindings;
    static providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];
    constructor(getFindings) {
        this.getFindings = getFindings;
    }
    provideCodeActions(document, range) {
        if (isGeneratedFindingsFile(document)) {
            return [];
        }
        const findings = this.getFindings(document.uri);
        if (!findings.length) {
            return [];
        }
        const cursorLine = range.start.line + 1;
        const actions = [];
        findings.forEach((f, idx) => {
            const start = findingStartLine(f);
            const end = findingEndLine(f) ?? start;
            if (!start || !end) {
                return;
            }
            if (cursorLine < start || cursorLine > end) {
                return;
            }
            const title = String(f.title || `Finding ${idx + 1}`);
            const severity = String(f.severity || "info");
            const apply = new vscode.CodeAction(`CodeReview: Apply fix - ${title} (${severity})`, vscode.CodeActionKind.QuickFix);
            apply.command = {
                title: "Apply fix",
                command: "codereview.acceptFindingFix",
                arguments: [document.uri.toString(), idx],
            };
            apply.isPreferred = true;
            actions.push(apply);
            const generate = new vscode.CodeAction(`CodeReview: Generate fix - ${title}`, vscode.CodeActionKind.QuickFix);
            generate.command = {
                title: "Generate fix",
                command: "codereview.generateFixFromReport",
                arguments: [document.uri.toString(), idx, ""],
            };
            actions.push(generate);
            const reject = new vscode.CodeAction(`CodeReview: Reject - ${title}`, vscode.CodeActionKind.QuickFix);
            reject.command = {
                title: "Reject finding",
                command: "codereview.rejectFinding",
                arguments: [document.uri.toString(), idx],
            };
            actions.push(reject);
        });
        return actions;
    }
}
class FindingsViewProvider {
    context;
    view;
    state = { busy: false, findings: [] };
    constructor(context) {
        this.context = context;
    }
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
        };
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.action === "review") {
                await vscode.commands.executeCommand("codereview.reviewActiveFile");
            }
            else if (msg.action === "openReport") {
                await vscode.commands.executeCommand("codereview.openReportPanel");
            }
            else if (msg.action === "fixLine") {
                await vscode.commands.executeCommand("codereview.fixCurrentLine");
            }
            else if (msg.action === "acceptFix") {
                await vscode.commands.executeCommand("codereview.acceptFindingFix", msg.fileUri, msg.findingIndex);
            }
            else if (msg.action === "rejectFix") {
                await vscode.commands.executeCommand("codereview.rejectFinding", msg.fileUri, msg.findingIndex);
            }
            else if (msg.action === "setKey") {
                await vscode.commands.executeCommand("codereview.setApiKey");
            }
            else if (msg.action === "clearKey") {
                await vscode.commands.executeCommand("codereview.clearApiKey");
            }
            else if (msg.action === "applyFixes") {
                await vscode.commands.executeCommand("codereview.applySuggestedFixes");
            }
            else if (msg.action === "commitPush") {
                await vscode.commands.executeCommand("codereview.commitAndPush");
            }
        });
        this.render();
    }
    async reveal() {
        try {
            await vscode.commands.executeCommand("codereview.findingsView.focus");
            return;
        }
        catch { }
        await vscode.commands.executeCommand("workbench.view.explorer");
    }
    setBusy(filePath, fileUri) {
        this.state = {
            ...this.state,
            busy: true,
            error: undefined,
            filePath,
            fileUri,
            lastRunAt: new Date().toLocaleTimeString(),
        };
        this.render();
    }
    setResults(filePath, fileUri, findings) {
        this.state = {
            busy: false,
            findings,
            filePath,
            fileUri,
            error: undefined,
            lastRunAt: new Date().toLocaleTimeString(),
        };
        this.render();
    }
    setError(message) {
        this.state = { ...this.state, busy: false, error: message };
        this.render();
    }
    render() {
        if (!this.view) {
            return;
        }
        this.view.webview.html = renderSidebarHtml(this.state);
    }
}
async function getApiKey(context, forcePrompt = false) {
    if (!forcePrompt) {
        const key = await context.secrets.get("codereview.apiKey");
        if (key) {
            return key;
        }
    }
    const input = await vscode.window.showInputBox({
        title: "CodeReview API key",
        prompt: "Enter the key from API_KEYS (before the colon). Example: if API_KEYS=devkey:0000..., type devkey",
        password: true,
        ignoreFocusOut: true,
    });
    if (input) {
        await context.secrets.store("codereview.apiKey", input.trim());
        return input.trim();
    }
    return undefined;
}
async function callRealtimeReview(context, payload) {
    const config = vscode.workspace.getConfiguration("codereview");
    const base = (config.get("apiBaseUrl") || "http://localhost:8000").replace(/\/$/, "");
    const token = await getApiKey(context);
    if (!token) {
        throw new Error("API key required. Run command: CodeReview: Set API Key");
    }
    const res = await fetch(`${base}/v1/reviews/realtime`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    });
    if (res.status === 401) {
        throw new Error("Unauthorized (401). Your API key does not match the server API_KEYS. " +
            "Run 'CodeReview: Set API Key' and enter only devkey (not the UUID). " +
            "Then restart Docker if you changed infra/compose/.env.");
    }
    if (!res.ok) {
        const t = await res.text();
        throw new Error(`API ${res.status}: ${t}`);
    }
    return res.json();
}
async function generateFixSuggestion(context, doc, finding) {
    const start = findingStartLine(finding) ?? 1;
    const end = findingEndLine(finding) ?? start;
    const safeStart = Math.max(1, Math.min(start, doc.lineCount));
    const safeEnd = Math.max(safeStart, Math.min(end, doc.lineCount));
    const range = new vscode.Range(new vscode.Position(safeStart - 1, 0), new vscode.Position(safeEnd - 1, doc.lineAt(safeEnd - 1).text.length));
    const snippet = doc.getText(range);
    const ctxStart = Math.max(1, safeStart - 3);
    const ctxEnd = Math.min(doc.lineCount, safeEnd + 3);
    const contextRange = new vscode.Range(new vscode.Position(ctxStart - 1, 0), new vscode.Position(ctxEnd - 1, doc.lineAt(ctxEnd - 1).text.length));
    const surrounding = doc.getText(contextRange);
    const title = String(finding.title || "Issue");
    const detail = String(finding.detail || "");
    const prompt = [
        "You are a code-fixing assistant.",
        "Return STRICT JSON of the form:",
        '{"findings":[{"title":"...","detail":"...","category":"security|bug|quality","severity":"low|medium|high|critical","start_line":' +
            safeStart +
            ',"end_line":' +
            safeEnd +
            ',"suggested_fix":"<code>"}]}',
        "STRICT RULES for suggested_fix:",
        "- Must be ONLY the replacement source code lines for the affected line range.",
        "- No markdown fences, no language tag, no bullets, no quotes, no prose.",
        "- Preserve indentation of the original lines being replaced.",
        "- Must compile/parse as valid " + (doc.languageId || "code") + ".",
        `Issue title: ${title}`,
        `Issue detail: ${detail}`,
        `Replace exactly lines ${safeStart}-${safeEnd} with safer code.`,
        `Surrounding context (for reference, do NOT include in suggested_fix):`,
        "```",
        surrounding,
        "```",
        `Lines to replace (these and only these):`,
        "```",
        snippet,
        "```",
    ].join("\n");
    const result = await callRealtimeReview(context, {
        language: doc.languageId,
        path: doc.uri.fsPath,
        content: prompt,
        enable_memory: false,
    });
    const candidates = (result.findings || []);
    for (const cand of candidates) {
        const sanitized = sanitizeReplacementToCode(cand.suggested_fix);
        if (sanitized) {
            return sanitized;
        }
    }
    const first = candidates[0];
    return normalizeSuggestedFix(first?.suggested_fix);
}
function alignFindingLinesForFix(doc, finding, fix) {
    const start = findingStartLine(finding) ?? 1;
    const end = findingEndLine(finding) ?? start;
    const lo = Math.max(1, start - 3);
    const hi = Math.min(doc.lineCount, end + 6);
    const fixTrim = fix.trim();
    for (let ln = lo; ln <= hi; ln += 1) {
        const raw = doc.lineAt(ln - 1).text;
        const rawTrim = raw.trim();
        if (rawTrim === fixTrim) {
            return { ...finding, suggested_fix: fix, start_line: ln, end_line: ln };
        }
        if (/%\s*0\b/.test(raw) && /%\s*i\b/.test(fix)) {
            const modMatch = raw.match(/^(\s*)if\s*\((.+)\)\s*:\s*$/);
            if (modMatch) {
                const rebuilt = `${modMatch[1]}if (${modMatch[2].replace(/%\s*0\b/, "% i")}):`.trim();
                if (fixTrim === rebuilt) {
                    return { ...finding, suggested_fix: fix, start_line: ln, end_line: ln };
                }
            }
        }
        if (/^\s*print\s*\(/.test(raw) && fix.includes("#") && fix.includes("unnecessary")) {
            const indent = raw.match(/^(\s*)/)?.[1] ?? "";
            const commented = `${indent}# ${raw.trim()}  # removed unnecessary print`;
            return { ...finding, suggested_fix: commented, start_line: ln, end_line: ln };
        }
    }
    return { ...finding, suggested_fix: fix };
}
function getDeterministicFix(doc, finding) {
    const startLine = findingStartLine(finding);
    const endLine = findingEndLine(finding) ?? startLine;
    if (!startLine || startLine < 1 || startLine > doc.lineCount) {
        return undefined;
    }
    const ctxStart = Math.max(1, startLine - 2);
    const ctxEnd = Math.min(doc.lineCount, (endLine ?? startLine) + 6);
    const blockLines = [];
    for (let i = ctxStart; i <= ctxEnd; i += 1) {
        blockLines.push(doc.lineAt(i - 1).text);
    }
    const block = blockLines.join("\n");
    const lang = doc.languageId;
    const title = String(finding.title || "").toLowerCase();
    const category = String(finding.category || "").toLowerCase();
    const severity = String(finding.severity || "").toLowerCase();
    const detail = String(finding.detail || "").toLowerCase();
    const combined = `${title} ${detail}`;
    if (lang === "python") {
        const sqlAssignConcat = block.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*\s*=\s*)(["'])(.*?(?:SELECT|INSERT|UPDATE|DELETE|WHERE).*?)\3\s*\+\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*$/i);
        if (sqlAssignConcat) {
            const [, indent, lhs, quote, sqlBody, varName] = sqlAssignConcat;
            const paramKw = combined.includes("postgres") || combined.includes("psycopg") ? "%s" : "?";
            return `${indent}${lhs}${quote}${sqlBody}${paramKw}${quote}  # use placeholder; pass (${varName},) to execute()`;
        }
        const sqlExecuteConcat = block.match(/^(\s*)([\w.]*\bexecute)\s*\(\s*(["'])(.*?(?:SELECT|INSERT|UPDATE|DELETE|WHERE).*?)\3\s*\+\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\)\s*$/i);
        if (sqlExecuteConcat) {
            const [, indent, exec, quote, sqlBody, varName] = sqlExecuteConcat;
            return `${indent}${exec}(${quote}${sqlBody}?${quote}, (${varName},))`;
        }
        const sqlExecuteFString = block.match(/^(\s*)([\w.]*\bexecute)\s*\(\s*f(["'])(.+?)\3\s*\)\s*$/);
        if (sqlExecuteFString) {
            const [, indent, exec, quote, fbody] = sqlExecuteFString;
            const params = [];
            const replaced = fbody.replace(/\{([^}]+)\}/g, (_full, name) => {
                params.push(String(name).trim());
                return "?";
            });
            if (params.length > 0) {
                const tuple = params.length === 1 ? `(${params[0]},)` : `(${params.join(", ")})`;
                return `${indent}${exec}(${quote}${replaced}${quote}, ${tuple})`;
            }
        }
        for (let li = 0; li < blockLines.length; li += 1) {
            const line = blockLines[li];
            const modZero = line.match(/^(\s*)if\s*\((.+)\)\s*:\s*$/);
            if (!modZero || !/%\s*0\b/.test(line)) {
                continue;
            }
            let loopVar = "i";
            for (let j = li - 1; j >= 0; j -= 1) {
                const fm = blockLines[j].match(/for\s+(\w+)\s+in\s+range/);
                if (fm) {
                    loopVar = fm[1];
                    break;
                }
            }
            const [, indent, condition] = modZero;
            const fixedCond = condition.replace(/%\s*0\b/, `% ${loopVar}`);
            return `${indent}if (${fixedCond}):`;
        }
        const isUnnecessaryPrint = combined.includes("unnecessary") ||
            combined.includes("debug print") ||
            (combined.includes("print") &&
                (category === "quality" || severity === "info" || severity === "low") &&
                !combined.includes("sensitive") &&
                !combined.includes("prime"));
        if (isUnnecessaryPrint) {
            const printLn = blockLines.find((ln) => /^\s*print\s*\(/.test(ln));
            if (printLn) {
                const pm = printLn.match(/^(\s*)(.+)$/);
                if (pm) {
                    return `${pm[1]}# ${pm[2].trim()}  # removed unnecessary print`;
                }
            }
        }
        const printLine = blockLines.find((ln) => /^\s*print\s*\(/.test(ln));
        if (printLine) {
            const printMatch = printLine.match(/^(\s*)print\s*\((.+)\)\s*$/);
            const arg = printMatch?.[2]?.toLowerCase() ?? "";
            const sensitiveInArg = /password|token|secret|api[_-]?key|ssn|credential|user_id|email|auth/.test(arg);
            const sensitiveInText = /password|token|secret|api[_-]?key|ssn|credential/.test(combined);
            if (sensitiveInArg ||
                (sensitiveInText &&
                    !combined.includes("division") &&
                    !combined.includes("overflow") &&
                    !combined.includes("prime"))) {
                const indent = printMatch?.[1] ?? "";
                return `${indent}# CodeReview: removed potentially sensitive print()`;
            }
        }
        const bareExcept = block.match(/^(\s*)except\s*:\s*$/);
        if (bareExcept) {
            return `${bareExcept[1]}except Exception:`;
        }
        const evalCall = block.match(/^(\s*)(.*?)\beval\s*\(([^)]*)\)(.*)$/);
        if (evalCall && (combined.includes("eval") || category === "security")) {
            const [, indent, before, inner, after] = evalCall;
            return `${indent}${before}__import__("ast").literal_eval(${inner})${after}`;
        }
        const osSystem = block.match(/^(\s*)os\.system\s*\(\s*(.+?)\s*\)\s*$/);
        if (osSystem) {
            const [, indent, arg] = osSystem;
            return `${indent}__import__("subprocess").run(${arg}.split(), check=True)  # avoid shell injection`;
        }
        const hardcodedSecret = block.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(["'])([^"'\s]{8,})\3\s*$/);
        if (hardcodedSecret &&
            (combined.includes("secret") ||
                combined.includes("password") ||
                combined.includes("token") ||
                combined.includes("api key") ||
                combined.includes("hardcoded"))) {
            const [, indent, name] = hardcodedSecret;
            const envName = name.toUpperCase();
            return `${indent}${name} = __import__("os").environ["${envName}"]  # load from env, never hardcode`;
        }
        const wantsErrorHandling = combined.includes("error handling") ||
            combined.includes("exception") ||
            combined.includes("handle") ||
            combined.includes("try/except") ||
            combined.includes("try except") ||
            combined.includes("connection issue") ||
            combined.includes("query error");
        if (wantsErrorHandling && blockLines.length > 0) {
            const indentMatch = blockLines[0].match(/^(\s*)/);
            const baseIndent = indentMatch ? indentMatch[1] : "";
            const extraIndent = "    ";
            const wrapped = [];
            wrapped.push(`${baseIndent}try:`);
            for (const ln of blockLines) {
                if (!ln.trim()) {
                    wrapped.push(ln);
                    continue;
                }
                wrapped.push(`${extraIndent}${ln}`);
            }
            wrapped.push(`${baseIndent}except Exception as exc:`);
            wrapped.push(`${baseIndent}${extraIndent}print(f"Error: {exc}")`);
            wrapped.push(`${baseIndent}${extraIndent}raise`);
            return wrapped.join("\n");
        }
        const wantsInputValidation = (combined.includes("input validation") ||
            combined.includes("validate input") ||
            combined.includes("validate") ||
            combined.includes("sanitize") ||
            combined.includes("logic bug") ||
            combined.includes("type") ||
            combined.includes("typeerror")) &&
            /\binput\s*\(/.test(block);
        if (wantsInputValidation) {
            const inputVars = [];
            blockLines.forEach((ln, i) => {
                const m = ln.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*input\(([^)]*)\)\s*$/);
                if (m) {
                    const varName = m[2];
                    const numericUse = blockLines.some((other, j) => j !== i &&
                        new RegExp(`\\b${varName}\\b\\s*(?:[<>!=]=?|==)\\s*-?\\d`).test(other));
                    inputVars.push({ lineIdx: i, varName, indent: m[1], promptArg: m[3], numericUse });
                }
            });
            let target = inputVars.find((v) => v.numericUse);
            if (!target) {
                target = inputVars.find((v) => combined.includes(v.varName.toLowerCase()));
            }
            if (!target) {
                target = inputVars[0];
            }
            if (target) {
                const t = target;
                const replacement = blockLines
                    .map((other, i) => {
                    if (i !== t.lineIdx) {
                        return other;
                    }
                    if (t.numericUse) {
                        return [
                            `${t.indent}try:`,
                            `${t.indent}    ${t.varName} = int(input(${t.promptArg}))`,
                            `${t.indent}except ValueError:`,
                            `${t.indent}    raise ValueError("Invalid input for ${t.varName}; expected an integer.")`,
                        ].join("\n");
                    }
                    return [
                        `${t.indent}${t.varName} = input(${t.promptArg}).strip()`,
                        `${t.indent}if not ${t.varName}:`,
                        `${t.indent}    raise ValueError("Invalid input for ${t.varName}; expected a non-empty value.")`,
                    ].join("\n");
                })
                    .join("\n");
                return replacement;
            }
        }
        const wantsContextManager = combined.includes("resource leak") ||
            combined.includes("not closed") ||
            combined.includes("context manager") ||
            combined.includes("with statement");
        if (wantsContextManager) {
            const connectMatch = block.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*((?:sqlite3|psycopg2|mysql\.connector)\.connect\([^)]*\))\s*$/);
            if (connectMatch) {
                const [, indent, varName, callExpr] = connectMatch;
                return `${indent}with ${callExpr} as ${varName}:  # context manager auto-closes the connection`;
            }
        }
        const wantsAssertRemoval = /^\s*assert\b/.test(block) &&
            (combined.includes("assert") || combined.includes("disabled"));
        if (wantsAssertRemoval) {
            const assertMatch = block.match(/^(\s*)assert\s+([^,]+?)(?:,\s*(.+))?\s*$/);
            if (assertMatch) {
                const [, indent, cond, msg] = assertMatch;
                const errMsg = msg ? msg.trim() : `"assertion failed: ${cond.trim()}"`;
                return [
                    `${indent}if not (${cond.trim()}):`,
                    `${indent}    raise AssertionError(${errMsg})`,
                ].join("\n");
            }
        }
    }
    if (lang === "javascript" || lang === "typescript") {
        const sqlConcat = block.match(/^(\s*)([\w.]*\b(?:query|execute|raw))\s*\(\s*(`|"|')(.*?(?:SELECT|INSERT|UPDATE|DELETE|WHERE).*?)\3\s*\+\s*([a-zA-Z_$][\w$]*)\s*\)\s*;?\s*$/i);
        if (sqlConcat) {
            const [, indent, fn, quote, sqlBody, varName] = sqlConcat;
            return `${indent}${fn}(${quote}${sqlBody}?${quote}, [${varName}]);`;
        }
        const evalCall = block.match(/^(\s*)(.*?)\beval\s*\(([^)]*)\)(.*)$/);
        if (evalCall && (combined.includes("eval") || category === "security")) {
            const [, indent, before, inner, after] = evalCall;
            return `${indent}${before}JSON.parse(${inner})${after}  // safer than eval`;
        }
    }
    return undefined;
}
async function ensureApplicableFix(context, doc, finding) {
    if (sanitizeReplacementToCode(finding.suggested_fix)) {
        return finding;
    }
    const deterministic = getDeterministicFix(doc, finding);
    if (deterministic) {
        return alignFindingLinesForFix(doc, finding, deterministic);
    }
    return await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `CodeReview: generating fix for "${String(finding.title || "finding")}"...`,
        cancellable: false,
    }, async () => {
        try {
            const generated = await generateFixSuggestion(context, doc, finding);
            if (generated) {
                const patched = { ...finding, suggested_fix: generated };
                if (sanitizeReplacementToCode(patched.suggested_fix)) {
                    return alignFindingLinesForFix(doc, finding, String(patched.suggested_fix));
                }
            }
        }
        catch {
            // fall through to deterministic retry
        }
        const retry = getDeterministicFix(doc, finding);
        if (retry) {
            return alignFindingLinesForFix(doc, finding, retry);
        }
        return undefined;
    });
}
function findingsToDiagnostics(doc, findings) {
    const diags = [];
    for (const f of findings) {
        const sev = mapSeverity(String(f.severity || "medium"));
        const startLine = typeof f.start_line === "number" && f.start_line > 0 ? f.start_line - 1 : 0;
        const range = new vscode.Range(startLine, 0, startLine, Number.MAX_SAFE_INTEGER);
        const message = `${f.title}: ${f.detail}`;
        const d = new vscode.Diagnostic(range, message, sev);
        d.code = String(f.category || "quality");
        d.source = "codereview";
        diags.push(d);
    }
    return diags;
}
function mapSeverity(s) {
    if (s === "critical" || s === "high") {
        return vscode.DiagnosticSeverity.Warning;
    }
    if (s === "medium") {
        return vscode.DiagnosticSeverity.Information;
    }
    return vscode.DiagnosticSeverity.Hint;
}
function sanitizeFileNamePart(input) {
    return input.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
}
function isGeneratedFindingsFile(doc) {
    const p = doc.uri.fsPath.replace(/\\/g, "/").toLowerCase();
    return p.endsWith(".findings.md") || p.endsWith(".findings.json") || p.includes("/.codereview/");
}
function parseLineValue(value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    if (typeof value === "string") {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) {
            return n;
        }
    }
    return undefined;
}
function normalizeSuggestedFix(value) {
    const raw = String(value || "").trim();
    if (!raw) {
        return undefined;
    }
    const suggestionFence = raw.match(/```suggestion\s*([\s\S]*?)```/i);
    if (suggestionFence) {
        return suggestionFence[1].trim();
    }
    const genericFence = raw.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
    if (genericFence) {
        return genericFence[1].trim();
    }
    return raw;
}
function looksLikeCodeLine(line) {
    const s = line.trim();
    if (!s) {
        return false;
    }
    if (/^(if|elif|else|for|while|def|class|return|try|except|finally|import|from|print)\b/.test(s)) {
        return true;
    }
    if (/^(const|let|var|function|class|return|if|for|while|try|catch|import|export)\b/.test(s)) {
        return true;
    }
    if (/^[\}\{\]\[]/.test(s)) {
        return true;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(s)) {
        return true;
    }
    if (/[;{}()[\]=:+\-*/%]/.test(s) && !/[.!?]$/.test(s)) {
        return true;
    }
    return false;
}
function sanitizeReplacementToCode(value) {
    const raw = normalizeSuggestedFix(value);
    if (!raw) {
        return undefined;
    }
    const lines = raw.split(/\r?\n/);
    const firstCodeIdx = lines.findIndex((ln) => looksLikeCodeLine(ln));
    if (firstCodeIdx === -1) {
        return undefined;
    }
    const candidate = lines.slice(firstCodeIdx).join("\n").trim();
    if (!candidate) {
        return undefined;
    }
    const lower = candidate.toLowerCase();
    if (lower.startsWith("remove ") ||
        lower.startsWith("use ") ||
        lower.startsWith("consider ") ||
        lower.startsWith("please ")) {
        return undefined;
    }
    return candidate;
}
function findingStartLine(finding) {
    return parseLineValue(finding.start_line);
}
function findingEndLine(finding) {
    return parseLineValue(finding.end_line) ?? parseLineValue(finding.start_line);
}
function findingAppliesToLine(finding, oneBasedLine) {
    const start = findingStartLine(finding);
    const end = findingEndLine(finding);
    if (!start || !end) {
        return false;
    }
    return oneBasedLine >= start && oneBasedLine <= end;
}
async function applySuggestedFixesToDocument(doc, findings) {
    const edits = [];
    for (const finding of findings) {
        const replacement = sanitizeReplacementToCode(finding.suggested_fix);
        if (!replacement) {
            continue;
        }
        const startLine = parseLineValue(finding.start_line);
        const endLine = parseLineValue(finding.end_line) ?? startLine;
        if (!startLine || !endLine) {
            continue;
        }
        if (startLine > doc.lineCount || endLine > doc.lineCount || endLine < startLine) {
            continue;
        }
        edits.push({ start: startLine, end: endLine, replacement });
    }
    if (edits.length === 0) {
        return 0;
    }
    const applied = await previewAndApplyEdits(doc, edits);
    return applied ? edits.length : 0;
}
function renderEditsPreviewText(original, edits) {
    const lines = original.split(/\r?\n/);
    edits.sort((a, b) => b.start - a.start);
    for (const edit of edits) {
        const startIdx = edit.start - 1;
        const endIdx = edit.end - 1;
        const replacementLines = edit.replacement.split(/\r?\n/);
        lines.splice(startIdx, endIdx - startIdx + 1, ...replacementLines);
    }
    return lines.join("\n");
}
async function previewAndApplyEdits(doc, edits) {
    const original = doc.getText();
    const proposed = renderEditsPreviewText(original, [...edits]);
    const previewDoc = await vscode.workspace.openTextDocument({
        language: doc.languageId,
        content: proposed,
    });
    await vscode.commands.executeCommand("vscode.diff", doc.uri, previewDoc.uri, `CodeReview Preview: ${doc.fileName.split(/[\\/]/).pop() ?? "file"}`);
    const choice = await vscode.window.showWarningMessage(`Apply ${edits.length} proposed CodeReview fix(es)?`, { modal: true }, "Apply", "Cancel");
    if (choice !== "Apply") {
        return false;
    }
    edits.sort((a, b) => b.start - a.start);
    const wsEdit = new vscode.WorkspaceEdit();
    for (const edit of edits) {
        const startIdx = edit.start - 1;
        const endIdx = edit.end - 1;
        const endLine = doc.lineAt(endIdx);
        const range = new vscode.Range(new vscode.Position(startIdx, 0), new vscode.Position(endIdx, endLine.text.length));
        wsEdit.replace(doc.uri, range, edit.replacement);
    }
    const ok = await vscode.workspace.applyEdit(wsEdit);
    if (ok) {
        await doc.save();
    }
    return ok;
}
async function runGitCommand(cwd, args) {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, windowsHide: true });
    return `${stdout || ""}${stderr || ""}`.trim();
}
async function writeFindingsReportFile(doc, findings) {
    const config = vscode.workspace.getConfiguration("codereview");
    const outputDir = (config.get("findingsOutputDir") || ".codereview").trim() || ".codereview";
    const ws = vscode.workspace.getWorkspaceFolder(doc.uri);
    const baseUri = ws?.uri ?? vscode.Uri.file(doc.uri.fsPath.replace(/[\\/][^\\/]+$/, ""));
    const dirUri = vscode.Uri.joinPath(baseUri, outputDir);
    await vscode.workspace.fs.createDirectory(dirUri);
    const relativePath = ws ? vscode.workspace.asRelativePath(doc.uri, false) : doc.uri.fsPath;
    const fileStem = sanitizeFileNamePart(relativePath.replace(/[\\/]/g, "__"));
    const reportUri = vscode.Uri.joinPath(dirUri, `${fileStem}.findings.md`);
    const sidecarUri = vscode.Uri.joinPath(dirUri, `${fileStem}.findings.json`);
    const createdAt = new Date().toISOString();
    const langTag = doc.languageId || "";
    const totalLines = doc.lineCount;
    const lines = [];
    lines.push(`# CodeReview Findings`);
    lines.push("");
    lines.push(`- Source: \`${relativePath}\``);
    lines.push(`- Generated: \`${createdAt}\``);
    lines.push(`- Findings: **${findings.length}**`);
    lines.push("");
    lines.push("> Click the CodeLens buttons (Apply Fix / Generate Fix / Reject) shown above each finding.");
    lines.push("");
    if (findings.length === 0) {
        lines.push("No findings reported. The code looks clean for this run.");
    }
    else {
        findings.forEach((f, idx) => {
            const title = String(f.title || "Finding");
            const detail = String(f.detail || "No detail provided by model.");
            const sev = String(f.severity || "unknown");
            const cat = String(f.category || "unknown");
            const path = String(f.path || relativePath);
            const startLine = parseLineValue(f.start_line);
            const endLine = parseLineValue(f.end_line) ?? startLine;
            const locLine = startLine ? `:${startLine}` : "";
            const fix = sanitizeReplacementToCode(f.suggested_fix);
            const hasFix = !!fix;
            const argPayload = encodeURIComponent(JSON.stringify([doc.uri.toString(), idx, sidecarUri.toString()]));
            const markerAttrs = [
                `docUri="${doc.uri.toString()}"`,
                `idx=${idx}`,
                `sidecarUri="${sidecarUri.toString()}"`,
                `hasFix=${hasFix ? "true" : "false"}`,
                `source="${relativePath}"`,
            ].join(" ");
            lines.push("---");
            lines.push("");
            lines.push(`<!-- codereview:actions ${markerAttrs} -->`);
            lines.push(`## ${idx + 1}. ${title}`);
            lines.push(`- Type: \`${cat}\``);
            lines.push(`- Severity: \`${sev}\``);
            lines.push(`- Location: \`${path}${locLine}\``);
            lines.push("");
            lines.push(`**Problem**`);
            lines.push("");
            lines.push(detail);
            lines.push("");
            if (startLine && endLine && startLine <= totalLines) {
                const ctxStart = Math.max(1, startLine - 1);
                const ctxEnd = Math.min(totalLines, endLine + 1);
                const snippet = [];
                for (let ln = ctxStart; ln <= ctxEnd; ln += 1) {
                    const text = doc.lineAt(ln - 1).text;
                    const marker = ln >= startLine && ln <= endLine ? ">" : " ";
                    snippet.push(`${marker} ${String(ln).padStart(4, " ")} | ${text}`);
                }
                lines.push(`**Current code (lines ${startLine}-${endLine})**`);
                lines.push("");
                lines.push("```" + (langTag || ""));
                lines.push(...snippet);
                lines.push("```");
                lines.push("");
            }
            if (hasFix) {
                lines.push(`**Expected code**`);
                lines.push("");
                lines.push("```" + (langTag || ""));
                lines.push(fix);
                lines.push("```");
                lines.push("");
            }
            else {
                lines.push(`**Expected code**`);
                lines.push("");
                lines.push("_No fix generated yet. Click_ `Generate Fix` _above to request one._");
                lines.push("");
            }
            const acceptArgs = argPayload;
            const acceptLabel = hasFix ? "Apply Fix" : "Apply Fix (will generate)";
            lines.push(`Actions: [${acceptLabel}](command:codereview.applyFixFromReport?${acceptArgs})` +
                ` · [Generate Fix](command:codereview.generateFixFromReport?${acceptArgs})` +
                ` · [Reject](command:codereview.rejectFindingFromReport?${acceptArgs})`);
            lines.push("");
        });
    }
    await vscode.workspace.fs.writeFile(reportUri, new TextEncoder().encode(lines.join("\n")));
    await vscode.workspace.fs.writeFile(sidecarUri, new TextEncoder().encode(JSON.stringify({
        version: 1,
        sourceUri: doc.uri.toString(),
        generatedAt: createdAt,
        findings,
    }, null, 2)));
    return reportUri;
}
function activate(context) {
    const diagnostics = vscode.languages.createDiagnosticCollection(DIAG_COLLECTION);
    const inFlight = new Set();
    const findingsView = new FindingsViewProvider(context);
    const reviewStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    const reportStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    const fixLineStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    let latestReportUri;
    const latestFindingsByDoc = new Map();
    const reportCodeLensProvider = new FindingsReportCodeLensProvider();
    const buildDecoration = (color) => vscode.window.createTextEditorDecorationType({
        overviewRulerColor: color,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        after: { contentText: "  ●", color, margin: "0 0 0 1rem" },
    });
    const decorationBySeverity = {
        critical: buildDecoration("#d73a49"),
        high: buildDecoration("#e36209"),
        medium: buildDecoration("#dbab09"),
        low: buildDecoration("#0366d6"),
        info: buildDecoration("#6a737d"),
    };
    const refreshDecorations = (doc, findings) => {
        const editors = vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === doc.uri.toString());
        const grouped = {};
        for (const f of findings) {
            const start = findingStartLine(f);
            const end = findingEndLine(f) ?? start;
            if (!start || !end) {
                continue;
            }
            const sev = String(f.severity || "info").toLowerCase();
            const key = decorationBySeverity[sev] ? sev : "info";
            const range = new vscode.Range(start - 1, 0, end - 1, Number.MAX_SAFE_INTEGER);
            (grouped[key] = grouped[key] || []).push(range);
        }
        for (const editor of editors) {
            for (const sev of Object.keys(decorationBySeverity)) {
                editor.setDecorations(decorationBySeverity[sev], grouped[sev] || []);
            }
        }
    };
    const openReportPanelForDoc = (doc, findings) => {
        const lines = [];
        for (let i = 0; i < doc.lineCount; i += 1) {
            lines.push(doc.lineAt(i).text);
        }
        const state = {
            docUri: doc.uri.toString(),
            filePath: doc.uri.fsPath,
            language: doc.languageId,
            findings,
            sourceLines: lines,
            generatedAt: new Date().toISOString(),
        };
        ReportPanel.createOrShow(context, state, async (msg) => {
            const currentFindings = latestFindingsByDoc.get(doc.uri.toString()) || [];
            switch (msg.action) {
                case "reviewAgain": {
                    const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
                    await review(editor);
                    return;
                }
                case "openSource": {
                    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
                    return;
                }
                case "commitPush": {
                    await vscode.commands.executeCommand("codereview.commitAndPush");
                    return;
                }
                case "applyAll": {
                    await vscode.commands.executeCommand("codereview.applyAllFixesFromReport", doc.uri.toString());
                    return;
                }
            }
            if (typeof msg.index !== "number" || !currentFindings[msg.index]) {
                vscode.window.showWarningMessage("Finding no longer available. Run review again.");
                return;
            }
            if (msg.action === "reveal") {
                const target = currentFindings[msg.index];
                const start = findingStartLine(target);
                if (start) {
                    const editor = await vscode.window.showTextDocument(doc, {
                        preview: false,
                        viewColumn: vscode.ViewColumn.One,
                    });
                    const pos = new vscode.Position(Math.max(0, start - 1), 0);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }
                return;
            }
            if (msg.action === "reject") {
                await vscode.commands.executeCommand("codereview.rejectFinding", doc.uri.toString(), msg.index);
                return;
            }
            if (msg.action === "apply") {
                await vscode.commands.executeCommand("codereview.acceptFindingFix", doc.uri.toString(), msg.index);
                return;
            }
            if (msg.action === "generate") {
                await vscode.commands.executeCommand("codereview.generateFixOnly", doc.uri.toString(), msg.index);
                return;
            }
        });
    };
    const persistFindingsState = async (doc, findings) => {
        latestFindingsByDoc.set(doc.uri.toString(), findings);
        findingsView.setResults(doc.uri.fsPath, doc.uri.toString(), findings);
        refreshDecorations(doc, findings);
        const writeFindingsToFile = vscode.workspace.getConfiguration("codereview").get("writeFindingsToFile") ?? true;
        if (writeFindingsToFile) {
            latestReportUri = await writeFindingsReportFile(doc, findings);
        }
        if (ReportPanel.current) {
            openReportPanelForDoc(doc, findings);
        }
    };
    reviewStatus.text = "$(play) Review";
    reviewStatus.tooltip = "CodeReview: review the active file";
    reviewStatus.command = "codereview.reviewActiveFile";
    reviewStatus.show();
    reportStatus.text = "$(preview) Report";
    reportStatus.tooltip = "Open the CodeReview Report panel for the active file";
    reportStatus.command = "codereview.openReportPanel";
    reportStatus.show();
    fixLineStatus.text = "$(wrench) Fix Line";
    fixLineStatus.tooltip = "Apply a CodeReview fix to the current line";
    fixLineStatus.command = "codereview.fixCurrentLine";
    fixLineStatus.show();
    const review = async (editor, range) => {
        const doc = editor.document;
        if (isGeneratedFindingsFile(doc)) {
            vscode.window.showInformationMessage("CodeReview skipped: this is a generated findings/report file. Open your source code file.");
            return;
        }
        findingsView.setBusy(doc.uri.fsPath, doc.uri.toString());
        const text = range ? doc.getText(range) : doc.getText();
        const config = vscode.workspace.getConfiguration("codereview");
        const model = (config.get("model") ?? "").trim();
        const provider = (config.get("provider") ?? "").trim();
        const payload = {
            language: doc.languageId,
            path: doc.uri.fsPath,
            content: text,
            enable_memory: config.get("enableMemory") ?? false,
        };
        if (model) {
            payload.model = model;
        }
        if (provider) {
            payload.provider = provider;
        }
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "CodeReview",
                cancellable: false,
            }, async () => {
                const result = await callRealtimeReview(context, payload);
                const findings = result.findings || [];
                if (result.llm_warning) {
                    vscode.window.showWarningMessage(`CodeReview: ${result.llm_warning}`);
                }
                const publishDiagnostics = vscode.workspace.getConfiguration("codereview").get("publishDiagnostics") ??
                    false;
                if (publishDiagnostics) {
                    diagnostics.set(doc.uri, findingsToDiagnostics(doc, findings));
                }
                else {
                    diagnostics.delete(doc.uri);
                }
                await persistFindingsState(doc, findings);
                const openAfter = vscode.workspace
                    .getConfiguration("codereview")
                    .get("openFindingsFileAfterReview") ?? true;
                if (openAfter) {
                    openReportPanelForDoc(doc, findings);
                }
                if (findings.length === 0) {
                    vscode.window.showInformationMessage("CodeReview: no issues reported (or model returned empty findings).");
                    return;
                }
                await findingsView.reveal();
                vscode.window.showInformationMessage(`CodeReview: ${findings.length} finding(s). See CodeReview sidebar and Problems panel.`);
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            findingsView.setError(msg);
            vscode.window.showErrorMessage(`CodeReview failed: ${msg}`);
        }
    };
    const reviewDocumentOnSave = async (doc) => {
        const config = vscode.workspace.getConfiguration("codereview");
        if (!(config.get("reviewOnSave") ?? false)) {
            return;
        }
        if (doc.uri.scheme !== "file") {
            return;
        }
        if (isGeneratedFindingsFile(doc)) {
            return;
        }
        const key = doc.uri.toString();
        if (inFlight.has(key)) {
            return;
        }
        const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
        if (!ed) {
            return;
        }
        inFlight.add(key);
        try {
            await review(ed);
        }
        finally {
            inFlight.delete(key);
        }
    };
    const codeActionProvider = new FindingsCodeActionProvider((uri) => latestFindingsByDoc.get(uri.toString()) || []);
    context.subscriptions.push(diagnostics, reviewStatus, reportStatus, fixLineStatus, vscode.languages.registerCodeLensProvider({ scheme: "file", language: "markdown", pattern: "**/*.findings.md" }, reportCodeLensProvider), vscode.languages.registerCodeActionsProvider({ scheme: "file" }, codeActionProvider, { providedCodeActionKinds: FindingsCodeActionProvider.providedCodeActionKinds }), vscode.window.onDidChangeVisibleTextEditors(() => {
        for (const editor of vscode.window.visibleTextEditors) {
            const findings = latestFindingsByDoc.get(editor.document.uri.toString());
            if (findings) {
                refreshDecorations(editor.document, findings);
            }
        }
    }), vscode.window.registerWebviewViewProvider("codereview.findingsView", findingsView), vscode.commands.registerCommand("codereview.setApiKey", async () => {
        await getApiKey(context, true);
        vscode.window.showInformationMessage("CodeReview API key saved.");
    }), vscode.commands.registerCommand("codereview.clearApiKey", async () => {
        await context.secrets.delete("codereview.apiKey");
        vscode.window.showInformationMessage("CodeReview API key cleared.");
    }), vscode.commands.registerTextEditorCommand("codereview.reviewSelection", (ed) => {
        const sel = ed.selection;
        if (sel.isEmpty) {
            vscode.window.showWarningMessage("Select code to review");
            return;
        }
        return review(ed, sel);
    }), vscode.commands.registerTextEditorCommand("codereview.reviewFile", (ed) => review(ed)), vscode.commands.registerCommand("codereview.reviewActiveFile", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("Open a file to review.");
            return;
        }
        await review(editor);
    }), vscode.commands.registerCommand("codereview.fixCurrentLine", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("Open a file and place cursor on a line first.");
            return;
        }
        const findings = latestFindingsByDoc.get(editor.document.uri.toString()) || [];
        if (findings.length === 0) {
            vscode.window.showInformationMessage("No findings for this file yet. Run review first.");
            return;
        }
        const line = editor.selection.active.line + 1;
        const candidates = findings.filter((f) => findingAppliesToLine(f, line));
        if (candidates.length === 0) {
            vscode.window.showInformationMessage(`No findings for line ${line}. Move cursor to a finding line and retry.`);
            return;
        }
        const selected = candidates.length === 1
            ? candidates[0]
            : await vscode.window.showQuickPick(candidates.map((f, idx) => ({
                label: String(f.title || `Finding ${idx + 1}`),
                description: `${String(f.severity || "unknown")} | line ${findingStartLine(f) || "?"}`,
                detail: String(f.detail || ""),
                finding: f,
            })), { title: `Apply fix on line ${line}` }).then((x) => x?.finding);
        if (!selected) {
            return;
        }
        const fixReady = await ensureApplicableFix(context, editor.document, selected);
        if (!fixReady) {
            const choice = await vscode.window.showWarningMessage("CodeReview could not produce a code-only fix for this line.\n\n" +
                "Reasons: the LLM returned prose, or the pattern is unknown. " +
                "You can switch to a stronger model (e.g. set codereview.model to llama3:latest or qwen2.5-coder:7b), " +
                "open the findings report for context, or edit the line manually.", { modal: true }, "Open Findings Report", "Edit Manually");
            if (choice === "Open Findings Report") {
                await vscode.commands.executeCommand("codereview.openLatestFindingsFile");
            }
            return;
        }
        const applied = await applySuggestedFixesToDocument(editor.document, [fixReady]);
        if (applied === 0) {
            vscode.window.showInformationMessage("Could not apply fix automatically for this finding (suggestion was not valid code).");
            return;
        }
        vscode.window.showInformationMessage("Applied suggested fix for current line.");
    }), vscode.workspace.onDidSaveTextDocument(reviewDocumentOnSave), vscode.commands.registerCommand("codereview.openPanel", async () => {
        await findingsView.reveal();
    }), vscode.commands.registerCommand("codereview.openLatestFindingsFile", async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && !isGeneratedFindingsFile(editor.document)) {
            const findings = latestFindingsByDoc.get(editor.document.uri.toString());
            if (findings) {
                openReportPanelForDoc(editor.document, findings);
                return;
            }
        }
        if (!latestReportUri) {
            vscode.window.showInformationMessage("No findings yet. Run a review first.");
            return;
        }
        const opened = await vscode.workspace.openTextDocument(latestReportUri);
        await vscode.window.showTextDocument(opened, { preview: false });
    }), vscode.commands.registerCommand("codereview.openReportPanel", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("Open a source file first.");
            return;
        }
        const findings = latestFindingsByDoc.get(editor.document.uri.toString());
        if (!findings) {
            vscode.window.showInformationMessage("No findings for this file. Run review first.");
            return;
        }
        openReportPanelForDoc(editor.document, findings);
    }), vscode.commands.registerCommand("codereview.runReportActionAtCursor", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("Open a findings report first.");
            return;
        }
        const doc = editor.document;
        if (!doc.fileName.toLowerCase().endsWith(".findings.md")) {
            vscode.window.showInformationMessage("This command works only on .findings.md report files.");
            return;
        }
        const line = doc.lineAt(editor.selection.active.line).text;
        const parsed = parseReportActionFromLine(line);
        if (!parsed) {
            vscode.window.showInformationMessage("No report action found on this line. Place cursor on the Action line.");
            return;
        }
        await vscode.commands.executeCommand(parsed.command, ...(parsed.args || []));
    }), vscode.commands.registerCommand("codereview.applySuggestedFixes", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("Open a file first.");
            return;
        }
        const findings = latestFindingsByDoc.get(editor.document.uri.toString()) || [];
        if (findings.length === 0) {
            vscode.window.showInformationMessage("No findings for this file yet. Run review first.");
            return;
        }
        const ready = [];
        for (const f of findings) {
            const r = await ensureApplicableFix(context, editor.document, f);
            if (r) {
                ready.push(r);
            }
        }
        if (ready.length === 0) {
            vscode.window.showInformationMessage("No auto-applicable suggested fixes found. Use Fix Current Line on individual findings.");
            return;
        }
        const applied = await applySuggestedFixesToDocument(editor.document, ready);
        if (applied === 0) {
            vscode.window.showInformationMessage("No fixes applied.");
            return;
        }
        vscode.window.showInformationMessage(`Applied ${applied} suggested fix(es) to active file.`);
    }), vscode.commands.registerCommand("codereview.applyFixFromReport", async (...args) => {
        const docUriString = typeof args[0] === "string" ? args[0] : undefined;
        const idxRaw = args[1];
        const sidecarUriString = typeof args[2] === "string" ? args[2] : undefined;
        const findingIndex = typeof idxRaw === "number" ? idxRaw : typeof idxRaw === "string" ? Number.parseInt(idxRaw, 10) : NaN;
        if (!docUriString || !Number.isFinite(findingIndex)) {
            vscode.window.showErrorMessage("Invalid fix link. Re-run review to regenerate report.");
            return;
        }
        let findings = latestFindingsByDoc.get(docUriString);
        if ((!findings || !findings[findingIndex]) && sidecarUriString) {
            try {
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(sidecarUriString));
                const parsed = JSON.parse(new TextDecoder().decode(bytes));
                if (Array.isArray(parsed.findings)) {
                    findings = parsed.findings;
                }
            }
            catch {
                // Keep fallback error below.
            }
        }
        if (!findings || !findings[findingIndex]) {
            vscode.window.showErrorMessage("Could not find matching finding. Re-run review to refresh report.");
            return;
        }
        const targetDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(docUriString));
        await vscode.window.showTextDocument(targetDoc, { preview: false });
        const fixReady = await ensureApplicableFix(context, targetDoc, findings[findingIndex]);
        if (!fixReady) {
            vscode.window.showInformationMessage("No safe code fix available for this finding. Try Generate Fix or edit manually.");
            return;
        }
        const applied = await applySuggestedFixesToDocument(targetDoc, [fixReady]);
        if (applied === 0) {
            vscode.window.showInformationMessage("This finding has no auto-applicable fix.");
            return;
        }
        vscode.window.showInformationMessage("Applied fix from findings report.");
    }), vscode.commands.registerCommand("codereview.generateFixFromReport", async (...args) => {
        const docUriString = typeof args[0] === "string" ? args[0] : undefined;
        const idxRaw = args[1];
        const sidecarUriString = typeof args[2] === "string" ? args[2] : undefined;
        const findingIndex = typeof idxRaw === "number" ? idxRaw : typeof idxRaw === "string" ? Number.parseInt(idxRaw, 10) : NaN;
        if (!docUriString || !Number.isFinite(findingIndex)) {
            vscode.window.showErrorMessage("Invalid fix link.");
            return;
        }
        let findings = latestFindingsByDoc.get(docUriString);
        if ((!findings || !findings[findingIndex]) && sidecarUriString) {
            try {
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(sidecarUriString));
                const parsed = JSON.parse(new TextDecoder().decode(bytes));
                if (Array.isArray(parsed.findings)) {
                    findings = parsed.findings;
                }
            }
            catch { }
        }
        if (!findings || !findings[findingIndex]) {
            vscode.window.showErrorMessage("Could not find this finding. Re-run review.");
            return;
        }
        const targetDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(docUriString));
        await vscode.window.showTextDocument(targetDoc, { preview: false });
        const finding = findings[findingIndex];
        const fixReady = await ensureApplicableFix(context, targetDoc, finding);
        if (!fixReady) {
            const title = String(finding.title || "this finding");
            const start = findingStartLine(finding);
            const lineHint = start ? ` (line ${start})` : "";
            const choice = await vscode.window.showWarningMessage(`Could not generate a safe code fix for "${title}"${lineHint}.\n\n` +
                "The local model returned text that does not look like code and no built-in template matched this pattern. " +
                "Switch to a stronger model (e.g. set codereview.model to llama3:latest or qwen2.5-coder:7b), " +
                "or jump to the line and edit manually.", { modal: true }, "Go to Line", "Open Report Panel", "Dismiss");
            if (choice === "Go to Line" && start) {
                const ed = await vscode.window.showTextDocument(targetDoc, { preview: false });
                const pos = new vscode.Position(Math.max(0, start - 1), 0);
                ed.selection = new vscode.Selection(pos, pos);
                ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            }
            else if (choice === "Open Report Panel") {
                await vscode.commands.executeCommand("codereview.openReportPanel");
            }
            return;
        }
        const applied = await applySuggestedFixesToDocument(targetDoc, [fixReady]);
        if (applied === 0) {
            vscode.window.showInformationMessage("Generated fix could not be auto-applied.");
            return;
        }
        vscode.window.showInformationMessage("Generated and applied fix from findings report.");
    }), vscode.commands.registerCommand("codereview.generateFixOnly", async (docUriString, idxRaw) => {
        const resolvedDocUri = typeof docUriString === "string" ? docUriString : "";
        const findingIndex = typeof idxRaw === "number"
            ? idxRaw
            : typeof idxRaw === "string"
                ? Number.parseInt(idxRaw, 10)
                : NaN;
        if (!resolvedDocUri || !Number.isFinite(findingIndex)) {
            vscode.window.showErrorMessage("Invalid Generate Fix action.");
            return;
        }
        const findings = latestFindingsByDoc.get(resolvedDocUri) || [];
        const finding = findings[findingIndex];
        if (!finding) {
            vscode.window.showErrorMessage("Finding not found. Re-run review.");
            return;
        }
        const targetDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(resolvedDocUri));
        const patched = await ensureApplicableFix(context, targetDoc, finding);
        if (!patched) {
            const title = String(finding.title || "this finding");
            const start = findingStartLine(finding);
            const lineHint = start ? ` (line ${start})` : "";
            const hasModZero = findings.some((f) => String(f.title || "").toLowerCase().includes("modulo") ||
                String(f.title || "").toLowerCase().includes("division or modulo"));
            await vscode.window.showWarningMessage(`CodeReview could not generate a code-only fix for "${title}"${lineHint}.\n\n` +
                (hasModZero
                    ? "Tip: use Apply Fix on the 'Division or modulo by zero' finding first (line 7).\n\n"
                    : "") +
                "For vague items (unnecessary print, unclear prime), click Reject Finding.\n\n" +
                "Or try a stronger model: codereview.model = llama3:latest", { modal: true }, "Reject Finding", "OK").then((choice) => {
                if (choice === "Reject Finding") {
                    void vscode.commands.executeCommand("codereview.rejectFinding", resolvedDocUri, findingIndex);
                }
            });
            return;
        }
        const updated = findings.map((f, i) => (i === findingIndex ? patched : f));
        await persistFindingsState(targetDoc, updated);
        vscode.window.showInformationMessage(`Generated fix for "${String(patched.title || "finding")}" (line ${findingStartLine(patched) ?? "?"}). Click Apply Fix to use it.`);
    }), vscode.commands.registerCommand("codereview.rejectFindingFromReport", async (...args) => {
        const docUriString = typeof args[0] === "string" ? args[0] : undefined;
        const idxRaw = args[1];
        const sidecarUriString = typeof args[2] === "string" ? args[2] : undefined;
        const findingIndex = typeof idxRaw === "number"
            ? idxRaw
            : typeof idxRaw === "string"
                ? Number.parseInt(idxRaw, 10)
                : NaN;
        if (!docUriString || !Number.isFinite(findingIndex)) {
            vscode.window.showErrorMessage("Invalid Reject action.");
            return;
        }
        let findings = latestFindingsByDoc.get(docUriString);
        if ((!findings || !findings[findingIndex]) && sidecarUriString) {
            try {
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(sidecarUriString));
                const parsed = JSON.parse(new TextDecoder().decode(bytes));
                if (Array.isArray(parsed.findings)) {
                    findings = parsed.findings;
                }
            }
            catch {
                // fall through
            }
        }
        if (!findings || !findings[findingIndex]) {
            vscode.window.showErrorMessage("Finding not found. Re-run review.");
            return;
        }
        const targetDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(docUriString));
        const updated = findings.filter((_, i) => i !== findingIndex);
        latestFindingsByDoc.set(docUriString, updated);
        await persistFindingsState(targetDoc, updated);
        vscode.window.showInformationMessage("Rejected finding and removed it from the report.");
    }), vscode.commands.registerCommand("codereview.applyAllFixesFromReport", async (docUriString) => {
        if (!docUriString) {
            vscode.window.showErrorMessage("Missing source doc reference.");
            return;
        }
        const findings = latestFindingsByDoc.get(docUriString) || [];
        if (findings.length === 0) {
            vscode.window.showInformationMessage("No findings to apply for this file.");
            return;
        }
        const targetDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(docUriString));
        await vscode.window.showTextDocument(targetDoc, { preview: false });
        const ready = [];
        for (const f of findings) {
            const r = await ensureApplicableFix(context, targetDoc, f);
            if (r) {
                ready.push(r);
            }
        }
        if (ready.length === 0) {
            vscode.window.showInformationMessage("No auto-applicable fixes were available.");
            return;
        }
        const applied = await applySuggestedFixesToDocument(targetDoc, ready);
        if (applied === 0) {
            vscode.window.showInformationMessage("No fixes applied.");
            return;
        }
        const remaining = findings.filter((f) => !ready.some((r) => r === f || r.title === f.title && r.start_line === f.start_line));
        await persistFindingsState(targetDoc, remaining);
        vscode.window.showInformationMessage(`Applied ${applied} fix(es).`);
    }), vscode.commands.registerCommand("codereview.reviewFromReport", async (docUriString) => {
        if (!docUriString) {
            vscode.window.showErrorMessage("Missing source doc reference.");
            return;
        }
        const targetDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(docUriString));
        const editor = await vscode.window.showTextDocument(targetDoc, { preview: false });
        await review(editor);
    }), vscode.commands.registerCommand("codereview.openSourceFromReport", async (docUriString) => {
        if (!docUriString) {
            vscode.window.showErrorMessage("Missing source doc reference.");
            return;
        }
        const targetDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(docUriString));
        await vscode.window.showTextDocument(targetDoc, { preview: false });
    }), vscode.commands.registerCommand("codereview.acceptFindingFix", async (docUriString, idxRaw) => {
        const resolvedDocUri = typeof docUriString === "string" ? docUriString : "";
        const findingIndex = typeof idxRaw === "number"
            ? idxRaw
            : typeof idxRaw === "string"
                ? Number.parseInt(idxRaw, 10)
                : NaN;
        if (!resolvedDocUri || !Number.isFinite(findingIndex)) {
            vscode.window.showErrorMessage("Invalid Accept Fix action.");
            return;
        }
        const findings = latestFindingsByDoc.get(resolvedDocUri) || [];
        const finding = findings[findingIndex];
        if (!finding) {
            vscode.window.showErrorMessage("Finding not found. Re-run review first.");
            return;
        }
        const targetDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(resolvedDocUri));
        await vscode.window.showTextDocument(targetDoc, { preview: false });
        const patchedFinding = await ensureApplicableFix(context, targetDoc, finding);
        if (!patchedFinding) {
            const title = String(finding.title || "this finding");
            const start = findingStartLine(finding);
            const lineHint = start ? ` (line ${start})` : "";
            const choice = await vscode.window.showWarningMessage(`CodeReview could not produce a code-only fix for "${title}"${lineHint}.\n\n` +
                "The model returned text instead of code and no built-in template matched. " +
                "Try a stronger model (codereview.model = llama3:latest or qwen2.5-coder:7b), " +
                "or jump to the line and edit it yourself.", { modal: true }, "Go to Line", "Reject Finding", "Dismiss");
            if (choice === "Go to Line" && start) {
                const ed = await vscode.window.showTextDocument(targetDoc, { preview: false });
                const pos = new vscode.Position(Math.max(0, start - 1), 0);
                ed.selection = new vscode.Selection(pos, pos);
                ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            }
            else if (choice === "Reject Finding") {
                await vscode.commands.executeCommand("codereview.rejectFinding", resolvedDocUri, findingIndex);
            }
            return;
        }
        const applied = await applySuggestedFixesToDocument(targetDoc, [patchedFinding]);
        if (applied === 0) {
            vscode.window.showInformationMessage("Could not apply this fix automatically (suggestion was not valid code).");
            return;
        }
        const updated = findings.filter((_, i) => i !== findingIndex);
        await persistFindingsState(targetDoc, updated);
        vscode.window.showInformationMessage("Accepted fix and updated code.");
    }), vscode.commands.registerCommand("codereview.rejectFinding", async (docUriString, idxRaw) => {
        const resolvedDocUri = typeof docUriString === "string" ? docUriString : "";
        const findingIndex = typeof idxRaw === "number"
            ? idxRaw
            : typeof idxRaw === "string"
                ? Number.parseInt(idxRaw, 10)
                : NaN;
        if (!resolvedDocUri || !Number.isFinite(findingIndex)) {
            vscode.window.showErrorMessage("Invalid Reject action.");
            return;
        }
        const findings = latestFindingsByDoc.get(resolvedDocUri) || [];
        if (!findings[findingIndex]) {
            vscode.window.showErrorMessage("Finding not found. Re-run review first.");
            return;
        }
        const targetDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(resolvedDocUri));
        const updated = findings.filter((_, i) => i !== findingIndex);
        await persistFindingsState(targetDoc, updated);
        vscode.window.showInformationMessage("Rejected finding and removed it from report.");
    }), vscode.commands.registerCommand("codereview.commitAndPush", async () => {
        const activeEditor = vscode.window.activeTextEditor;
        let folderPath;
        if (activeEditor) {
            const ws = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
            if (ws) {
                folderPath = ws.uri.fsPath;
            }
            else if (activeEditor.document.uri.scheme === "file") {
                folderPath = activeEditor.document.uri.fsPath.replace(/[\\/][^\\/]+$/, "");
            }
        }
        if (!folderPath) {
            folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        }
        if (!folderPath) {
            vscode.window.showErrorMessage("Open a file or workspace folder before running Commit & Push.");
            return;
        }
        const cwd = folderPath;
        try {
            let isRepo = false;
            try {
                const out = await runGitCommand(cwd, ["rev-parse", "--is-inside-work-tree"]);
                isRepo = out.trim() === "true";
            }
            catch {
                isRepo = false;
            }
            if (!isRepo) {
                const initChoice = await vscode.window.showWarningMessage(`Folder is not a Git repository:\n${cwd}\n\nInitialize a Git repository here so changes can be committed?`, { modal: true }, "Initialize Git Repo", "Cancel");
                if (initChoice !== "Initialize Git Repo") {
                    vscode.window.showInformationMessage("Commit cancelled.");
                    return;
                }
                await runGitCommand(cwd, ["init"]);
                try {
                    await runGitCommand(cwd, ["checkout", "-b", "main"]);
                }
                catch {
                    // branch may already exist
                }
            }
            const confirm = await vscode.window.showWarningMessage(`Stage and commit ALL local changes in:\n${cwd}\n\nContinue?`, { modal: true }, "Continue");
            if (confirm !== "Continue") {
                return;
            }
            const message = (await vscode.window.showInputBox({
                title: "Git commit message",
                value: "Apply CodeReview suggested fixes",
                ignoreFocusOut: true,
            })) || "";
            if (!message.trim()) {
                vscode.window.showWarningMessage("Commit cancelled: empty message.");
                return;
            }
            const status = await runGitCommand(cwd, ["status", "--porcelain"]);
            if (!status.trim()) {
                vscode.window.showInformationMessage("No local changes to commit.");
                return;
            }
            let originUrl = "";
            try {
                originUrl = (await runGitCommand(cwd, ["remote", "get-url", "origin"])).trim();
            }
            catch {
                originUrl = "";
            }
            const pushChoice = await vscode.window.showWarningMessage(originUrl
                ? `Push target is origin:\n${originUrl}\n\nProceed?`
                : "No origin remote configured. Add a GitHub remote URL to continue.", { modal: true }, "Confirm Push", "Change Remote", "Cancel");
            if (pushChoice !== "Confirm Push" && pushChoice !== "Change Remote") {
                vscode.window.showInformationMessage("Push cancelled.");
                return;
            }
            if (!originUrl || pushChoice === "Change Remote") {
                const remoteUrl = await vscode.window.showInputBox({
                    title: "Set GitHub remote URL",
                    prompt: "Enter GitHub URL (https://github.com/owner/repo.git or git@github.com:owner/repo.git)",
                    value: originUrl || "",
                    ignoreFocusOut: true,
                });
                if (!remoteUrl || !remoteUrl.trim()) {
                    vscode.window.showWarningMessage("Push cancelled: no remote URL provided.");
                    return;
                }
                const cleanUrl = remoteUrl.trim();
                if (originUrl) {
                    await runGitCommand(cwd, ["remote", "set-url", "origin", cleanUrl]);
                }
                else {
                    await runGitCommand(cwd, ["remote", "add", "origin", cleanUrl]);
                }
                originUrl = cleanUrl;
            }
            await runGitCommand(cwd, ["add", "-A"]);
            try {
                await runGitCommand(cwd, ["commit", "-m", message.trim()]);
            }
            catch (err) {
                const m = err instanceof Error ? err.message : String(err);
                if (/please tell me who you are/i.test(m) || /user\.email|user\.name/i.test(m)) {
                    const name = await vscode.window.showInputBox({
                        title: "Git user.name (local)",
                        prompt: "Your name for git commits (stored locally for this repo only)",
                        ignoreFocusOut: true,
                    });
                    const email = await vscode.window.showInputBox({
                        title: "Git user.email (local)",
                        prompt: "Your email for git commits (stored locally for this repo only)",
                        ignoreFocusOut: true,
                    });
                    if (!name || !email) {
                        vscode.window.showWarningMessage("Commit cancelled: git identity not provided.");
                        return;
                    }
                    await runGitCommand(cwd, ["config", "user.name", name]);
                    await runGitCommand(cwd, ["config", "user.email", email]);
                    await runGitCommand(cwd, ["commit", "-m", message.trim()]);
                }
                else {
                    throw err;
                }
            }
            await runGitCommand(cwd, ["push", "-u", "origin", "HEAD"]);
            vscode.window.showInformationMessage(`Changes committed and pushed to ${originUrl}.`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Commit/push failed: ${msg}`);
        }
    }));
}
function renderSidebarHtml(state) {
    const fileUri = state.fileUri || "";
    const rows = state.findings
        .map((f, idx) => {
        const title = String(f.title || "Finding");
        const detail = String(f.detail || "No detail provided by model.");
        const sev = String(f.severity || "unknown");
        const cat = String(f.category || "unknown");
        const path = String(f.path || "");
        const line = typeof f.start_line === "number" ? `:${f.start_line}` : "";
        const fix = String(f.suggested_fix || "").trim();
        const meta = `${cat} | ${sev}${path ? ` | ${path}${line}` : ""}`;
        const expectedCode = fix ? `<div style="margin-top:8px;font-size:12px;opacity:0.8;">Expected code</div>
<pre style="white-space:pre-wrap;">${escapeHtml(fix)}</pre>` : "";
        const actions = `<div style="display:flex;gap:8px;margin-top:8px;">
<button data-action="acceptFix" data-index="${idx}" data-file-uri="${escapeHtml(fileUri)}">Accept</button>
<button data-action="rejectFix" data-index="${idx}" data-file-uri="${escapeHtml(fileUri)}">Reject</button>
</div>`;
        return `<section style="margin-bottom:16px;padding:12px;border:1px solid #444;border-radius:8px;">
<h3 style="margin:0 0 8px 0;">${escapeHtml(title)}</h3>
<div style="opacity:0.8;font-size:12px;margin-bottom:8px;">${escapeHtml(meta)}</div>
<p style="white-space:pre-wrap;">${escapeHtml(detail)}</p>
${expectedCode}
${actions}
</section>`;
    })
        .join("");
    const body = rows || `<p style="opacity:0.8;">No findings yet. Click "Review Active File".</p>`;
    const status = state.busy
        ? `<div style="margin:8px 0;padding:8px;border:1px solid #35527a;border-radius:8px;">Review in progress...</div>`
        : "";
    const error = state.error
        ? `<div style="margin:8px 0;padding:8px;border:1px solid #7a3535;border-radius:8px;color:#ffb4b4;">${escapeHtml(state.error)}</div>`
        : "";
    const context = state.filePath
        ? `<div style="opacity:0.75;font-size:12px;margin-bottom:8px;">File: ${escapeHtml(state.filePath)}${state.lastRunAt ? ` | Last run: ${escapeHtml(state.lastRunAt)}` : ""}</div>`
        : `<div style="opacity:0.75;font-size:12px;margin-bottom:8px;">No file reviewed yet.</div>`;
    return `<!DOCTYPE html>
<html>
  <head><meta charset="UTF-8"/></head>
  <body style="font-family: var(--vscode-font-family); padding: 8px;">
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
      <button id="review">Review Active File</button>
      <button id="openReport">Open Report Panel</button>
      <button id="fixLine">Fix Current Line</button>
      <button id="applyFixes">Apply Suggested Fixes</button>
      <button id="commitPush">Commit & Push</button>
      <button id="setKey">Set API Key</button>
      <button id="clearKey">Clear API Key</button>
    </div>
    ${context}
    ${status}
    ${error}
    ${body}
    <script>
      const vscode = acquireVsCodeApi();
      document.getElementById("review")?.addEventListener("click", () => vscode.postMessage({ action: "review" }));
      document.getElementById("openReport")?.addEventListener("click", () => vscode.postMessage({ action: "openReport" }));
      document.getElementById("fixLine")?.addEventListener("click", () => vscode.postMessage({ action: "fixLine" }));
      document.getElementById("applyFixes")?.addEventListener("click", () => vscode.postMessage({ action: "applyFixes" }));
      document.getElementById("commitPush")?.addEventListener("click", () => vscode.postMessage({ action: "commitPush" }));
      document.getElementById("setKey")?.addEventListener("click", () => vscode.postMessage({ action: "setKey" }));
      document.getElementById("clearKey")?.addEventListener("click", () => vscode.postMessage({ action: "clearKey" }));
      document.querySelectorAll("button[data-action]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const action = btn.getAttribute("data-action");
          const findingIndex = Number.parseInt(btn.getAttribute("data-index") || "-1", 10);
          const fileUri = btn.getAttribute("data-file-uri") || "";
          vscode.postMessage({ action, findingIndex, fileUri });
        });
      });
    </script>
  </body>
</html>`;
}
function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function deactivate() { }
//# sourceMappingURL=extension.js.map
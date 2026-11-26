import { useState } from "react";
import { z } from "zod";
import { useAction, type ClientActionDefinition } from "../../lib/actionClient.js";

export interface DocumentItem {
  id: string;
  title: string;
  category: "golden-doc" | "architecture" | "planning";
  version: number;
  content: string;
  lastEditedBy: "human" | "agent";
  lastEditedAt: string;
}

export interface AgentActivityEvent {
  id: string;
  agent: string;
  action: string;
  target: string;
  timestamp: string;
}

interface PatchInput {
  documentId: string;
  content: string;
}

interface PatchOutput {
  success: boolean;
  documentId: string;
  bytesWritten: number;
  caller: string;
  timestamp: string;
}

const documentPatchAction: ClientActionDefinition<PatchInput, PatchOutput> = {
  id: "document_patch",
  name: "document_patch",
  description: "Apply in-place patch to document buffer",
  schema: z.object({
    documentId: z.string().min(1),
    content: z.string().min(1),
  }),
  run: async (input, ctx) => {
    return {
      success: true,
      documentId: input.documentId,
      bytesWritten: new TextEncoder().encode(input.content).length,
      caller: ctx.caller,
      timestamp: new Date().toISOString(),
    };
  },
};

const sampleDocs: DocumentItem[] = [
  {
    id: "doc-cv-001",
    title: "Angus Hally - Head of Product CV (Golden Doc)",
    category: "golden-doc",
    version: 14,
    content: "# Angus Hally\n\nHead of Product / AI Agent Systems\n\n## Summary\nAccomplished product leader building agent-native operating systems, knowledge architectures, and autonomous workflows.\n\n## Core Principles\n1. Single source of truth across all tools\n2. 100% Agent-UI capability parity\n3. Zero unauthenticated attack surface",
    lastEditedBy: "agent",
    lastEditedAt: "10 mins ago",
  },
  {
    id: "doc-arch-002",
    title: "ADR-100 System Architecture Specification",
    category: "architecture",
    version: 4,
    content: "# ADR-100: Unified Action Wrapper & Co-Editing Surface\n\n## Status\nAccepted\n\n## Blueprint\n- Phase 1: defineAction, adapters, and registrar\n- Phase 2: Authenticated collaborative workspace reversing ADR-096\n- Phase 3: Full capability migration across all connectors",
    lastEditedBy: "human",
    lastEditedAt: "1 hour ago",
  },
  {
    id: "doc-plan-003",
    title: "Q4 Roadmap: Automated Lineage & Memory Triage",
    category: "planning",
    version: 7,
    content: "# Q4 ahOS Roadmap\n\n- [x] Phase 1 Action Wrapper Core (#1258, #1259, #1260)\n- [/] Phase 2 Co-Editing Surface (#1261)\n- [ ] Machine proposal approval surface (#1218)\n- [ ] Google Docs In-Place Editing integration (#1255)",
    lastEditedBy: "agent",
    lastEditedAt: "2 hours ago",
  },
];

const sampleAgentActivity: AgentActivityEvent[] = [
  {
    id: "act-1",
    agent: "Claude (MCP)",
    action: "task_create",
    target: "Scaffold Phase 2 web surface",
    timestamp: "Just now",
  },
  {
    id: "act-2",
    agent: "Antigravity",
    action: "document_patch",
    target: "Updated ADR-100 Blueprint section",
    timestamp: "12m ago",
  },
  {
    id: "act-3",
    agent: "Discovery Routine",
    action: "document_duplicates",
    target: "Flagged 10 CV variants for review",
    timestamp: "45m ago",
  },
];

export function CoEditorCanvas() {
  const [documents, setDocuments] = useState<DocumentItem[]>(sampleDocs);
  const [selectedDocId, setSelectedDocId] = useState<string>(sampleDocs[0].id);
  const [activeContent, setActiveContent] = useState<string>(sampleDocs[0].content);
  const [saveStatus, setSaveStatus] = useState<string>("");

  const { execute, loading } = useAction(documentPatchAction);

  const selectedDoc = documents.find((d) => d.id === selectedDocId) || documents[0];

  const handleSelectDoc = (doc: DocumentItem) => {
    setSelectedDocId(doc.id);
    setActiveContent(doc.content);
    setSaveStatus("");
  };

  const handleSave = async () => {
    if (!activeContent.trim()) return;
    try {
      await execute({ documentId: selectedDoc.id, content: activeContent });
      setDocuments((prev) =>
        prev.map((d) =>
          d.id === selectedDoc.id
            ? { ...d, content: activeContent, version: d.version + 1, lastEditedBy: "human", lastEditedAt: "Just now" }
            : d,
        ),
      );
      setSaveStatus("Saved & synced with agent workspace");
      setTimeout(() => setSaveStatus(""), 3000);
    } catch {
      // Error handled by hook
    }
  };

  return (
    <div className="grid grid-cols-12 gap-6 h-[calc(100vh-140px)]">
      {/* 1. Document Sidebar */}
      <div className="col-span-3 bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Living Documents</h3>
          <span className="text-[11px] px-2 py-0.5 bg-slate-800 text-slate-300 rounded font-mono">
            {documents.length}
          </span>
        </div>
        <div className="space-y-1 overflow-y-auto flex-1">
          {documents.map((doc) => (
            <button
              type="button"
              key={doc.id}
              onClick={() => handleSelectDoc(doc)}
              className={`w-full text-left p-3 rounded-lg transition-colors text-xs ${
                selectedDoc.id === doc.id
                  ? "bg-indigo-600/20 border border-indigo-500/30 text-white"
                  : "hover:bg-slate-800/60 text-slate-300 border border-transparent"
              }`}
            >
              <div className="font-semibold truncate mb-1">{doc.title}</div>
              <div className="flex items-center justify-between text-[10px] text-slate-400">
                <span className="font-mono">v{doc.version}</span>
                <span>Edited {doc.lastEditedAt} by {doc.lastEditedBy}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 2. Collaborative Editor Canvas */}
      <div className="col-span-6 bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col">
        <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-4">
          <div>
            <h2 className="text-sm font-bold text-white truncate max-w-md">{selectedDoc.title}</h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[11px] font-mono text-indigo-400">v{selectedDoc.version}</span>
              <span className="text-slate-500">•</span>
              <span className="text-[11px] text-slate-400">Real-time sync enabled</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {saveStatus && (
              <span className="text-xs text-emerald-400 font-medium animate-pulse">
                {saveStatus}
              </span>
            )}
            <button
              type="button"
              disabled={loading}
              onClick={handleSave}
              className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors shadow-sm"
            >
              {loading ? "Patching..." : "Sync Patch"}
            </button>
          </div>
        </div>

        <textarea
          value={activeContent}
          onChange={(e) => setActiveContent(e.target.value)}
          placeholder="Document content..."
          className="flex-1 w-full bg-slate-950/80 border border-slate-800/80 rounded-lg p-4 font-mono text-xs text-slate-200 leading-relaxed resize-none focus:outline-none focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/80"
        />

        <div className="pt-3 border-t border-slate-800/60 mt-3 flex items-center justify-between text-[11px] text-slate-400">
          <span>{activeContent.length} characters</span>
          <span>Buffer: UTF-8</span>
        </div>
      </div>

      {/* 3. Realtime Agent Activity Stream */}
      <div className="col-span-3 bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Agent Co-Editing Feed</h3>
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
        </div>

        <div className="space-y-3 overflow-y-auto flex-1">
          {sampleAgentActivity.map((evt) => (
            <div key={evt.id} className="p-3 bg-slate-950/60 border border-slate-800/60 rounded-lg space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-indigo-400">{evt.agent}</span>
                <span className="text-[10px] text-slate-500">{evt.timestamp}</span>
              </div>
              <div className="text-[11px] font-mono text-slate-300">
                Action: <span className="text-emerald-400">{evt.action}</span>
              </div>
              <p className="text-[11px] text-slate-400 truncate">{evt.target}</p>
            </div>
          ))}
        </div>

        <div className="mt-3 pt-3 border-t border-slate-800 text-[11px] text-slate-400 text-center">
          Agent-UI Parity: Every agent tool call mirrors into this feed.
        </div>
      </div>
    </div>
  );
}

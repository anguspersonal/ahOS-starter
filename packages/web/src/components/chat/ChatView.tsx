import { useState, useRef, useEffect, type ChangeEvent, type KeyboardEvent } from "react";
import { useGeminiChat } from "../../lib/chatAction.js";
import { TAB_PATHS } from "../../lib/router.js";

const DEFAULT_FULL_STARTERS = [
  "Show all active entities in my knowledge graph",
  "Create an entity called 'Atlas AI' with tag 'agent-native' in domain 'work'",
  "Query entities in the 'angus' domain with limit 5",
  "Preview a bulk delete of any entities tagged 'test'",
];

const DEFAULT_MINI_STARTERS = [
  "Filter graph to projects",
  "Filter graph to people",
  "Create entity 'Vector Store' with type 'concept'",
  "Reset graph filters",
];

export interface ChatViewProps {
  variant?: "full" | "mini";
  title?: string;
  subtitle?: string;
  systemInstruction?: string;
  starterPrompts?: string[];
  placeholder?: string;
  selectedEntity?: { id: string; title: string; entity_type?: string } | null;
  onActionExecuted?: (actionName: string, args: Record<string, unknown>, result: unknown) => void;
  onFilterGraph?: (filter: {
    query?: string;
    entityType?: string;
    entityTypes?: string[];
    hierarchyLevel?: number | null;
    reset?: boolean;
  }) => void;
  onRefreshGraph?: () => void;
  onClose?: () => void;
  className?: string;
}

export function ChatView({
  variant = "full",
  title = "Gemini Chat",
  subtitle = "Interactive conversational intelligence with full knowledge graph Entity CRUD actions",
  systemInstruction,
  starterPrompts,
  placeholder,
  selectedEntity,
  onActionExecuted,
  onFilterGraph,
  onRefreshGraph,
  onClose,
  className = "",
}: ChatViewProps) {
  const isMini = variant === "mini";

  // Centralised Action Registry callback wrapper
  const handleActionExecuted = (
    actionName: string,
    args: Record<string, unknown>,
    result: unknown,
  ) => {
    // 1. Notify external handler
    onActionExecuted?.(actionName, args, result);

    // 2. Automated side-effects for knowledge graph
    if (actionName === "entity_crud") {
      const op = String(args.operation || "");
      if (["create", "delete", "bulk_delete", "update", "upsert"].includes(op)) {
        onRefreshGraph?.();
      }
      if (op === "query" && onFilterGraph) {
        if (typeof args.query === "string") {
          onFilterGraph({ query: args.query });
        } else if (typeof args.entity_type === "string") {
          onFilterGraph({ entityType: args.entity_type });
        }
      }
    } else if (actionName === "graph_filter" && onFilterGraph) {
      const types = Array.isArray(args.entity_types)
        ? (args.entity_types as string[])
        : typeof args.entity_type === "string"
        ? [args.entity_type]
        : undefined;
      onFilterGraph({
        query: typeof args.query === "string" ? args.query : undefined,
        entityType: typeof args.entity_type === "string" ? args.entity_type : undefined,
        entityTypes: types,
        hierarchyLevel: typeof args.hierarchy_level === "number" ? args.hierarchy_level : undefined,
        reset: Boolean(args.reset),
      });
    }
  };

  const {
    messages,
    isGenerating,
    error,
    model,
    setModel,
    apiKey,
    setApiKey,
    sendMessage,
    stopGenerating,
    clearChat,
  } = useGeminiChat(systemInstruction, {
    onActionExecuted: handleActionExecuted,
    contextEntity: selectedEntity,
  });

  const [inputPrompt, setInputPrompt] = useState("");
  const [streamEnabled, setStreamEnabled] = useState(true);
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [manualKey, setManualKey] = useState("");
  const [customSystemPrompt, setCustomSystemPrompt] = useState("");
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [expandedToolIdx, setExpandedToolIdx] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeStarters = starterPrompts || (isMini ? DEFAULT_MINI_STARTERS : DEFAULT_FULL_STARTERS);
  const defaultPlaceholder =
    placeholder ||
    (isMini
      ? selectedEntity
        ? `Ask about "${selectedEntity.title}" or say "delete this entity"...`
        : "Ask AI, add entity, or say 'filter to projects'..."
      : "Ask anything or request entity CRUD (e.g. 'Show all entities', 'Create entity X')...");

  // Auto-scroll to bottom when messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isGenerating]);

  // Adjust textarea height automatically
  const handleInputChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setInputPrompt(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, isMini ? 100 : 180)}px`;
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = (overridePrompt?: string) => {
    const textToSend = overridePrompt !== undefined ? overridePrompt : inputPrompt;
    const trimmed = textToSend.trim();
    if (!trimmed || isGenerating) {
      return;
    }
    sendMessage(trimmed, {
      stream: streamEnabled,
      systemInstruction: customSystemPrompt.trim() || undefined,
      enableTools: true,
    });
    if (overridePrompt === undefined) {
      setInputPrompt("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    }
  };

  const handleSaveKey = () => {
    if (manualKey.trim()) {
      setApiKey(manualKey.trim());
      setShowKeyInput(false);
      setManualKey("");
    }
  };

  const handleCopyMessage = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const toggleToolExpand = (id: string) => {
    setExpandedToolIdx((prev) => (prev === id ? null : id));
  };

  return (
    <div
      className={`flex flex-col bg-slate-950 rounded-xl border border-slate-800 shadow-2xl overflow-hidden ${
        isMini ? "h-full text-xs" : "h-[calc(100vh-140px)]"
      } ${className}`}
    >
      {/* 1. Header Toolbar */}
      <div
        className={`bg-slate-900/90 border-b border-slate-800 flex items-center justify-between gap-3 backdrop-blur ${
          isMini ? "px-3.5 py-2.5" : "px-6 py-3.5"
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={`rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 flex items-center justify-center font-bold flex-shrink-0 ${
              isMini ? "w-6 h-6 text-xs" : "w-8 h-8 text-sm"
            }`}
          >
            ✨
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h2 className={`font-semibold text-white truncate ${isMini ? "text-xs" : "text-sm"}`}>
                {title}
              </h2>
              <span className="px-1.5 py-0.2 rounded text-[9px] font-mono bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                CAR Active
              </span>
            </div>
            {!isMini && <p className="text-[11px] text-slate-400 truncate">{subtitle}</p>}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Selected Entity Indicator in Mini Mode */}
          {isMini && selectedEntity && (
            <span
              className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 max-w-[140px] truncate"
              title={`Active Selection: ${selectedEntity.title}`}
            >
              🎯 {selectedEntity.title}
            </span>
          )}

          {/* Model Selector (in full mode or compact dropdown) */}
          {!isMini ? (
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={isGenerating}
              className="bg-slate-950 border border-slate-700/80 rounded-lg px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
            >
              <option value="gemini-2.5-flash">gemini-2.5-flash (Recommended)</option>
              <option value="gemini-2.5-pro">gemini-2.5-pro</option>
              <option value="gemini-2.0-flash">gemini-2.0-flash</option>
              <option value="gemini-3.8-flash">gemini-3.8-flash</option>
            </select>
          ) : (
            <span className="text-[10px] font-mono text-slate-400 px-1.5 py-0.5 bg-slate-900 border border-slate-800 rounded">
              2.5-flash
            </span>
          )}

          {!isMini && (
            <>
              {/* Streaming Toggle */}
              <label className="flex items-center gap-1 text-[11px] text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={streamEnabled}
                  onChange={(e) => setStreamEnabled(e.target.checked)}
                  className="rounded bg-slate-900 border-slate-700 text-indigo-500 focus:ring-0"
                />
                <span>Stream</span>
              </label>

              {/* System Prompt Toggle */}
              <button
                type="button"
                onClick={() => setShowSystemPrompt(!showSystemPrompt)}
                className={`px-2 py-0.5 text-[11px] rounded-lg border transition-colors ${
                  customSystemPrompt
                    ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-300"
                    : "bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200"
                }`}
                title="Customize system instructions"
              >
                Prompt
              </button>
            </>
          )}

          {/* API Key Status / Toggle */}
          <button
            type="button"
            onClick={() => setShowKeyInput(!showKeyInput)}
            className={`px-2 py-0.5 text-[11px] rounded-lg border transition-colors flex items-center gap-1 ${
              apiKey
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
                : "bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20"
            }`}
            title={apiKey ? "API key configured" : "Configure GEMINI_KEY"}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${apiKey ? "bg-emerald-400" : "bg-amber-400 animate-pulse"}`}
            />
            <span>{apiKey ? (isMini ? "Key" : "Key Set") : "Add Key"}</span>
          </button>

          {/* Clear Thread */}
          <button
            type="button"
            onClick={clearChat}
            disabled={messages.length === 0}
            className="px-2 py-0.5 text-[11px] rounded-lg border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200 hover:border-slate-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Clear conversation thread"
          >
            Clear
          </button>

          {/* Close Button (if provided) */}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors ml-1"
              title="Close mini chat"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Optional System Prompt Banner */}
      {showSystemPrompt && !isMini && (
        <div className="px-6 py-2 bg-slate-900/95 border-b border-slate-800 flex items-center gap-2 text-xs">
          <span className="text-slate-400 font-medium whitespace-nowrap">System Prompt:</span>
          <input
            type="text"
            placeholder="Custom system instructions (e.g. Always respond in markdown tables)..."
            value={customSystemPrompt}
            onChange={(e) => setCustomSystemPrompt(e.target.value)}
            className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 min-w-0"
          />
        </div>
      )}

      {/* 2. Collapsible API Key Config Banner */}
      {showKeyInput && (
        <div className="px-4 py-2 bg-slate-900/95 border-b border-slate-800 flex items-center gap-2 animate-in fade-in duration-150 text-xs">
          <span className="text-slate-300 font-medium whitespace-nowrap">Gemini Key:</span>
          <input
            type="password"
            placeholder="AIzaSy... (or GEMINI_KEY in .env)"
            value={manualKey}
            onChange={(e) => setManualKey(e.target.value)}
            className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-0.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-indigo-500 min-w-0"
          />
          <button
            type="button"
            onClick={handleSaveKey}
            className="px-2.5 py-0.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg transition-colors whitespace-nowrap"
          >
            Save
          </button>
          {apiKey && (
            <button
              type="button"
              onClick={() => {
                setApiKey("");
                setShowKeyInput(false);
              }}
              className="px-2 py-0.5 bg-rose-900/30 hover:bg-rose-900/50 text-rose-300 rounded-lg transition-colors border border-rose-800/40 whitespace-nowrap"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* 3. Missing API Key Alert Notice */}
      {!apiKey && (
        <div className="px-4 py-2 bg-amber-950/40 border-b border-amber-800/50 flex items-center justify-between text-xs text-amber-200">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-amber-400 font-bold flex-shrink-0">⚠️</span>
            <span className="truncate">
              <strong>GEMINI_KEY</strong> required. Click <strong>Add Key</strong> to chat.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowKeyInput(true)}
            className="underline hover:text-amber-100 font-semibold text-xs ml-2 flex-shrink-0"
          >
            Enter Key
          </button>
        </div>
      )}

      {/* 4. Messages Thread Surface */}
      <div className={`flex-1 overflow-y-auto space-y-4 ${isMini ? "p-3.5" : "p-6"}`}>
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center py-6 px-2">
            <div
              className={`rounded-2xl bg-indigo-600/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center mb-3 shadow-inner ${
                isMini ? "w-10 h-10 text-xl" : "w-14 h-14 text-2xl"
              }`}
            >
              ✨
            </div>
            <h3 className={`font-semibold text-white mb-1.5 ${isMini ? "text-sm" : "text-lg"}`}>
              {isMini ? "Graph Copilot (CAR)" : "Agent-Native Gemini Chat"}
            </h3>
            <p className="text-[11px] text-slate-400 mb-4 max-w-sm">
              {isMini
                ? "Interact, filter, add, and delete entities dynamically via Centralised Action Registry."
                : "Ask questions or manage knowledge graph entities directly. Powered by Gemini 2.5 Flash connected to ADR-100 Action Registry."}
            </p>

            {/* Quick Action / Starter Prompts */}
            <div className="w-full flex flex-col gap-1.5 max-w-md">
              {/* Selected Node Context Chip (if present in Mini mode) */}
              {isMini && selectedEntity && (
                <button
                  type="button"
                  onClick={() => handleSubmit(`Show details for entity "${selectedEntity.title}"`)}
                  className="p-2 bg-emerald-950/40 hover:bg-emerald-900/60 border border-emerald-800/60 rounded-xl text-xs text-emerald-200 transition-all text-left flex items-center justify-between"
                >
                  <span className="truncate">🎯 Inspect selected: {selectedEntity.title}</span>
                  <span className="text-emerald-400 ml-2">→</span>
                </button>
              )}

              {activeStarters.map((promptText) => (
                <button
                  key={promptText}
                  type="button"
                  onClick={() => handleSubmit(promptText)}
                  className="p-2 bg-slate-900/70 hover:bg-slate-900 border border-slate-800 hover:border-indigo-500/40 rounded-xl text-xs text-slate-300 hover:text-white transition-all text-left flex items-center justify-between group shadow-sm"
                >
                  <span className="truncate">{promptText}</span>
                  <span className="text-indigo-400 ml-2 group-hover:translate-x-0.5 inline-block transition-transform">
                    →
                  </span>
                </button>
              ))}

              {/* Extra Mini delete prompt when entity is selected */}
              {isMini && selectedEntity && (
                <button
                  type="button"
                  onClick={() => handleSubmit(`Delete entity "${selectedEntity.title}" (id: ${selectedEntity.id})`)}
                  className="p-2 bg-rose-950/30 hover:bg-rose-900/50 border border-rose-800/40 rounded-xl text-xs text-rose-300 hover:text-rose-100 transition-all text-left flex items-center justify-between"
                >
                  <span className="truncate">🗑️ Delete selected entity</span>
                  <span className="text-rose-400 ml-2">→</span>
                </button>
              )}
            </div>
          </div>
        ) : (
          messages.map((message, idx) => {
            const isUser = message.role === "user";
            return (
              <div
                key={message.id || idx}
                className={`flex gap-2.5 ${isUser ? "justify-end" : "justify-start"}`}
              >
                {!isUser && (
                  <div className="w-6 h-6 rounded-lg bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 flex-shrink-0 flex items-center justify-center text-[10px] font-bold mt-0.5">
                    ✨
                  </div>
                )}

                <div
                  className={`group relative max-w-[85%] rounded-2xl px-3.5 py-2.5 leading-relaxed shadow-md space-y-2.5 ${
                    isUser
                      ? "bg-indigo-600 text-white rounded-br-none text-xs"
                      : "bg-slate-900 text-slate-200 border border-slate-800 rounded-bl-none text-xs"
                  }`}
                >
                  {/* Tool Call Execution Cards */}
                  {message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="space-y-1.5">
                      {message.toolCalls.map((tc, tIdx) => {
                        const callKey = `${message.id || idx}-tool-${tIdx}`;
                        const isExpanded = expandedToolIdx === callKey;
                        const operation = String(tc.args.operation || tc.args.query || tc.args.entity_type || "action");
                        const count = typeof tc.result?.count === "number" ? tc.result.count : undefined;

                        return (
                          <div
                            key={callKey}
                            className="bg-slate-950/80 border border-slate-800 rounded-xl p-2 text-[11px]"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="text-indigo-400 font-mono text-xs flex-shrink-0">🛠️</span>
                                <span className="font-semibold text-slate-200 truncate">{tc.name}</span>
                                <span className="px-1 py-0.2 bg-indigo-500/20 text-indigo-300 rounded font-mono text-[9px] truncate">
                                  {operation}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 flex-shrink-0">
                                {tc.status === "executing" && (
                                  <span className="text-amber-400 animate-pulse font-mono text-[10px]">
                                    executing...
                                  </span>
                                )}
                                {tc.status === "success" && (
                                  <span className="text-emerald-400 font-mono text-[10px]">
                                    {count !== undefined ? `${count} items` : "success"}
                                  </span>
                                )}
                                {tc.status === "pending_approval" && (
                                  <span className="text-amber-400 font-mono text-[10px]">
                                    waiting for your approval ·{" "}
                                    <a
                                      href={TAB_PATHS.approvals}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="underline hover:text-amber-300"
                                    >
                                      Approvals
                                    </a>
                                  </span>
                                )}
                                {tc.status === "error" && (
                                  <span className="text-rose-400 font-mono text-[10px]">
                                    failed
                                  </span>
                                )}
                                <button
                                  type="button"
                                  onClick={() => toggleToolExpand(callKey)}
                                  className="text-slate-400 hover:text-slate-200 underline text-[10px]"
                                >
                                  {isExpanded ? "hide" : "details"}
                                </button>
                              </div>
                            </div>

                            {/* Expanded Details / Result Preview */}
                            {isExpanded && (
                              <div className="mt-2 pt-2 border-t border-slate-800/80 font-mono text-[10px] space-y-1.5 text-slate-300">
                                <div>
                                  <span className="text-slate-500">Args: </span>
                                  <span className="break-all">{JSON.stringify(tc.args)}</span>
                                </div>
                                {tc.result && (
                                  <div>
                                    <span className="text-slate-500">Result: </span>
                                    <pre className="bg-slate-900 p-1.5 rounded max-h-28 overflow-y-auto text-[10px] text-slate-300 whitespace-pre-wrap break-all">
                                      {JSON.stringify(tc.result, null, 2)}
                                    </pre>
                                  </div>
                                )}
                                {tc.error && (
                                  <div className="text-rose-400">
                                    <span className="text-slate-500">Error: </span>
                                    <span>{tc.error}</span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Message text content */}
                  {message.content ? (
                    <div className="whitespace-pre-wrap font-sans space-y-2">
                      {message.content}
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 py-1 text-slate-400">
                      <span className="w-2 h-2 rounded-full bg-indigo-400 animate-ping" />
                      <span className="italic text-[11px]">
                        {message.toolCalls && message.toolCalls.some((tc) => tc.status === "executing")
                          ? "Executing CAR tool action..."
                          : "Generating response..."}
                      </span>
                    </div>
                  )}

                  {/* Copy Button */}
                  {message.content && (
                    <button
                      type="button"
                      onClick={() => handleCopyMessage(message.content, idx)}
                      title="Copy to clipboard"
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 bg-slate-800/80 hover:bg-slate-700 rounded text-[10px] text-slate-300"
                    >
                      {copiedIndex === idx ? "Copied" : "Copy"}
                    </button>
                  )}
                </div>

                {isUser && (
                  <div className="w-6 h-6 rounded-lg bg-slate-800 text-slate-300 border border-slate-700 flex-shrink-0 flex items-center justify-center text-[10px] font-semibold mt-0.5">
                    U
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 5. Error Banner */}
      {error && (
        <div className="px-4 py-2 bg-rose-950/60 border-t border-rose-800/50 flex items-center justify-between text-xs text-rose-200">
          <div className="flex items-center gap-2 truncate">
            <span className="text-rose-400 font-bold">Error:</span>
            <span className="truncate">{error.message}</span>
          </div>
          <button
            type="button"
            onClick={() => handleSubmit(messages[messages.length - 2]?.content || "")}
            className="underline hover:text-rose-100 font-medium text-xs ml-3 flex-shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* 6. Input Bottom Bar */}
      <div className={`bg-slate-900/90 border-t border-slate-800 ${isMini ? "p-2.5" : "p-4"}`}>
        <div className="flex items-end gap-2 max-w-4xl mx-auto">
          <div className="flex-1 bg-slate-950 rounded-xl border border-slate-800 focus-within:border-indigo-500/80 transition-colors p-1.5 flex flex-col">
            <textarea
              ref={textareaRef}
              value={inputPrompt}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={defaultPlaceholder}
              rows={1}
              disabled={isGenerating}
              className="w-full bg-transparent text-xs text-slate-100 placeholder-slate-500 focus:outline-none resize-none max-h-32 px-1 py-0.5"
            />
          </div>

          {isGenerating ? (
            <button
              type="button"
              onClick={stopGenerating}
              className="h-8 px-3 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-xl transition-colors flex items-center gap-1 shadow-lg shadow-rose-600/20 flex-shrink-0"
            >
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handleSubmit()}
              disabled={!inputPrompt.trim() || !apiKey}
              className="h-8 px-3.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl transition-colors flex items-center gap-1 shadow-lg shadow-indigo-600/20 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
            >
              <span>Send</span>
              <span>→</span>
            </button>
          )}
        </div>

        {/* Quick Context Chips under input in Mini mode */}
        {isMini && (
          <div className="flex items-center gap-1.5 mt-2 overflow-x-auto pb-0.5 scrollbar-none text-[10px]">
            <button
              type="button"
              onClick={() => handleSubmit("Filter graph to projects")}
              className="px-2 py-0.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-md text-slate-400 hover:text-slate-200 whitespace-nowrap transition-colors"
            >
              🔍 Projects
            </button>
            <button
              type="button"
              onClick={() => handleSubmit("Filter graph to people")}
              className="px-2 py-0.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-md text-slate-400 hover:text-slate-200 whitespace-nowrap transition-colors"
            >
              🔍 People
            </button>
            <button
              type="button"
              onClick={() => handleSubmit("Create a new entity called 'Neural Engine' with type 'system'")}
              className="px-2 py-0.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-md text-slate-400 hover:text-slate-200 whitespace-nowrap transition-colors"
            >
              ➕ Add Entity
            </button>
            <button
              type="button"
              onClick={() => handleSubmit("Reset graph filters")}
              className="px-2 py-0.5 bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-md text-slate-400 hover:text-slate-200 whitespace-nowrap transition-colors"
            >
              🔄 Reset Filter
            </button>
          </div>
        )}

        {!isMini && (
          <div className="flex items-center justify-between text-[10px] text-slate-400 mt-2 max-w-4xl mx-auto px-1 font-mono">
            <span>Centralised Action Registry (CAR) · Actions: entity_crud, graph_filter, task_crud, decision_review</span>
            <span>Shift+Enter for newline</span>
          </div>
        )}
      </div>
    </div>
  );
}

import { ChatView } from "./ChatView.js";

/**
 * Full page Chat Canvas rendered on the /chat route.
 * Reuses the shared ChatView module with variant="full".
 */
export function ChatCanvas() {
  return (
    <ChatView
      variant="full"
      title="Gemini Chat"
      subtitle="Interactive conversational intelligence with full knowledge graph Entity CRUD actions"
    />
  );
}
export default ChatCanvas;

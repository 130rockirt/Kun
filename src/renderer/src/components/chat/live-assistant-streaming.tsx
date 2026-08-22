import {
  createContext,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";

/**
 * While an unconfirmed busy flag is pending (a hydrated snapshot claims a
 * running turn but live events have not confirmed it), the live-assistant
 * typewriter must stay off: catch-up replay would otherwise re-type text that
 * the user already saw settle. The provider is mounted by the live assistant
 * bubble; `streaming` combines the caller's flag with this gate.
 */
const LiveAssistantStreamingContext = createContext<boolean>(true);

export function LiveAssistantStreamingProvider({
  streaming,
  children,
}: {
  streaming: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <LiveAssistantStreamingContext.Provider value={streaming}>
      {children}
    </LiveAssistantStreamingContext.Provider>
  );
}

export function useLiveAssistantStreaming(): boolean {
  return useContext(LiveAssistantStreamingContext);
}

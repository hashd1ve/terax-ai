import { usePreferencesStore } from "@/modules/settings/preferences";
import { showAgentToast } from "../components/AgentToast";
import { osNotify } from "./notify";

type AlertArgs = {
  agent: string;
  title: string;
  body?: string;
  focused: boolean;
  /** True when the user is currently looking at this agent. */
  visible: boolean;
  /** Allow an in-app toast when focused but not looking at the agent. */
  allowToast: boolean;
  onActivate: () => void;
};

/** Toast / OS-notify for an attention (needs-input) event. The bell history is
 *  written separately by the bridge; this function only alerts. */
export function alertAgentAttention({
  agent,
  title,
  body,
  focused,
  visible,
  allowToast,
  onActivate,
}: AlertArgs): void {
  if (!usePreferencesStore.getState().agentNotifications) return;
  if (focused && visible) return;
  if (!focused) {
    void osNotify(title, body ?? agent);
    return;
  }
  if (allowToast) {
    showAgentToast({ agent, title, body, onActivate });
  }
}

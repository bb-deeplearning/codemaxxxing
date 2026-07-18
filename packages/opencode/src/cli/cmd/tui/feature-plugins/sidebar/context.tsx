import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo } from "solid-js"
import { SidebarSection } from "../../component/sidebar-section"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

// afterglow: the context section is a decision instrument, not a gauge —
// plain dim facts, and the percent line takes heat (warning past 70,
// error past 90) exactly when it becomes a decision (specs/tui-redesign.md,
// "the context meter is a decision instrument").
function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const cost = createMemo(() => msg().reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0))

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  const percentColor = () => {
    const pct = state().percent ?? 0
    if (pct > 90) return theme().error
    if (pct > 70) return theme().warning
    return theme().textMuted
  }

  return (
    <box>
      <SidebarSection t={theme()} label="context" />
      {/* indent rhythm: section content at +2 under its header, matching
          TodoItem and the dialog category/option pattern. */}
      <box paddingLeft={2}>
        <text fg={theme().textMuted} wrapMode="none">
          {state().tokens.toLocaleString()} tokens
        </text>
        <text fg={percentColor()} wrapMode="none">
          {state().percent ?? 0}% used
        </text>
        <text fg={theme().textMuted} wrapMode="none">
          {money.format(cost())} spent
        </text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin

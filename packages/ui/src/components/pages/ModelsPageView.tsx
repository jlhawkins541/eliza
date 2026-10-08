/**
 * First-class owner-only Models page at `/models`. It renders the same
 * `ModelsSettingsSection` as Settings → Models & Providers (the workspace over
 * the existing account, voice, and advanced groups), so both entry points
 * share one set of API calls and one mutation surface.
 */

import {
  FramedPage,
  FramedPageBody,
  FramedPageHeader,
} from "../../layouts/framed-page";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { OwnerOnlyNotice, RoleGate } from "../RoleGate";
import { ModelsSettingsSection } from "../settings/models/ModelsWorkspace";
import type { ModelSettingsApi } from "../settings/models/useModelSettings";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

export interface ModelsPageViewProps {
  /** Client seam for stories and tests; defaults to the app client. */
  api?: ModelSettingsApi;
}

export function ModelsPageView({
  api,
}: ModelsPageViewProps = {}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <ShellViewAgentSurface viewId="models">
      <FramedPage
        gutterOwner="framed-page"
        data-testid="models-page"
        data-chat-clearance-aware="true"
      >
        <FramedPageHeader
          title={t("models.page.title", { defaultValue: "Models" })}
          description={t("models.page.description", {
            defaultValue:
              "Choose which AI provider and models Eliza uses. Keys stay encrypted in Accounts.",
          })}
        />
        <FramedPageBody scroll="view">
          <RoleGate
            minRole="OWNER"
            fallback={
              <OwnerOnlyNotice
                message={t("models.ownerOnly", {
                  defaultValue:
                    "Model settings are available to the workspace owner only.",
                })}
              />
            }
          >
            <ModelsSettingsSection api={api} />
          </RoleGate>
        </FramedPageBody>
      </FramedPage>
    </ShellViewAgentSurface>
  );
}

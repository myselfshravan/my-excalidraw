import {
  loginIcon,
  ExcalLogo,
  eyeIcon,
  LibraryIcon,
  PlusIcon,
  TrashIcon,
  LinkIcon,
  checkIcon,
} from "@excalidraw/excalidraw/components/icons";
import { MainMenu } from "@excalidraw/excalidraw/index";
import React, { useEffect, useState } from "react";

import { isDevEnv } from "@excalidraw/common";

import type { Theme } from "@excalidraw/element/types";

import { LanguageList } from "../app-language/LanguageList";
import { isExcalidrawPlusSignedUser } from "../app_constants";
import {
  listWorkspacesWithLocalOrder,
  parseShareLinkUrl,
  type Workspace,
} from "../data/workspaces";

import { saveDebugState } from "./DebugCanvas";

export type WorkspaceController = {
  current: Workspace | null;
  switchTo: (ws: Workspace) => void;
  createNew: () => Promise<void>;
  rename: (ws: Workspace, newName: string) => Promise<Workspace>;
  remove: (ws: Workspace) => Promise<void>;
};

const WorkspacesSubmenu: React.FC<{ controller: WorkspaceController }> = ({
  controller,
}) => {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-list on rename so the updated name shows immediately.
  useEffect(() => {
    let cancelled = false;
    listWorkspacesWithLocalOrder()
      .then((list) => {
        if (!cancelled) {
          setWorkspaces(list);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn("failed to list workspaces", err);
          setError("Couldn't load workspaces");
          setWorkspaces([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [controller.current?.docId, controller.current?.name]);

  const onCreate = () => {
    controller.createNew().catch((err) => {
      console.error(err);
      window.alert("Failed to create a new workspace.");
    });
  };

  const onRenameCurrent = () => {
    const current = controller.current;
    if (!current) {
      return;
    }
    const next = window.prompt("Rename workspace to:", current.name);
    if (!next || next.trim() === "" || next === current.name) {
      return;
    }
    controller.rename(current, next.trim()).catch((err) => {
      console.error(err);
      window.alert("Rename failed.");
    });
  };

  const onRemove = (ws: Workspace) => {
    if (
      !window.confirm(
        `Remove "${ws.name}" from the workspace list? The scene data stays in Firebase — anyone with the link can still open it.`,
      )
    ) {
      return;
    }
    controller.remove(ws).catch((err) => {
      console.error(err);
      window.alert("Remove failed.");
    });
  };

  const onOpenByLink = () => {
    const input = window.prompt(
      "Paste a workspace link (https://…/#json=id,key):",
    );
    if (!input) {
      return;
    }
    const parsed = parseShareLinkUrl(input.trim());
    if (!parsed) {
      window.alert("That doesn't look like a workspace link.");
      return;
    }
    window.location.href = `${window.location.origin}${window.location.pathname}#json=${parsed.id},${parsed.key}`;
  };

  const currentDocId = controller.current?.docId ?? null;

  return (
    <MainMenu.Sub>
      <MainMenu.Sub.Trigger icon={LibraryIcon}>Workspaces</MainMenu.Sub.Trigger>
      <MainMenu.Sub.Content>
        {workspaces === null && (
          <MainMenu.Item icon={undefined} onSelect={() => {}}>
            Loading…
          </MainMenu.Item>
        )}
        {workspaces !== null && workspaces.length === 0 && !error && (
          <MainMenu.Item icon={undefined} onSelect={() => {}}>
            No workspaces yet
          </MainMenu.Item>
        )}
        {error && (
          <MainMenu.Item icon={undefined} onSelect={() => {}}>
            {error}
          </MainMenu.Item>
        )}
        {workspaces?.slice(0, 20).map((ws) => {
          const isCurrent = ws.docId === currentDocId;
          return (
            <MainMenu.Item
              key={ws.docId}
              icon={isCurrent ? checkIcon : undefined}
              onSelect={() => {
                if (isCurrent) {
                  return;
                }
                controller.switchTo(ws);
              }}
            >
              {ws.name}
            </MainMenu.Item>
          );
        })}
        <MainMenu.Separator />
        <MainMenu.Item icon={PlusIcon} onSelect={onCreate}>
          New workspace
        </MainMenu.Item>
        <MainMenu.Item icon={LinkIcon} onSelect={onOpenByLink}>
          Open by link…
        </MainMenu.Item>
        {controller.current && (
          <>
            <MainMenu.Separator />
            <MainMenu.Item icon={undefined} onSelect={onRenameCurrent}>
              Rename current…
            </MainMenu.Item>
            <MainMenu.Item
              icon={TrashIcon}
              onSelect={() => onRemove(controller.current!)}
            >
              Remove current from list
            </MainMenu.Item>
          </>
        )}
      </MainMenu.Sub.Content>
    </MainMenu.Sub>
  );
};

export const AppMainMenu: React.FC<{
  onCollabDialogOpen: () => any;
  isCollaborating: boolean;
  isCollabEnabled: boolean;
  theme: Theme | "system";
  refresh: () => void;
  workspaceController: WorkspaceController;
}> = React.memo((props) => {
  return (
    <MainMenu>
      <WorkspacesSubmenu controller={props.workspaceController} />
      <MainMenu.Separator />
      <MainMenu.DefaultItems.LoadScene />
      <MainMenu.DefaultItems.SaveToActiveFile />
      <MainMenu.DefaultItems.Export />
      <MainMenu.DefaultItems.SaveAsImage />
      {props.isCollabEnabled && (
        <MainMenu.DefaultItems.LiveCollaborationTrigger
          isCollaborating={props.isCollaborating}
          onSelect={() => props.onCollabDialogOpen()}
        />
      )}
      <MainMenu.DefaultItems.CommandPalette className="highlighted" />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      <MainMenu.Separator />
      <MainMenu.ItemLink
        icon={ExcalLogo}
        href={`${
          import.meta.env.VITE_APP_PLUS_LP
        }/plus?utm_source=excalidraw&utm_medium=app&utm_content=hamburger`}
        className=""
      >
        Excalidraw+
      </MainMenu.ItemLink>
      <MainMenu.DefaultItems.Socials />
      <MainMenu.ItemLink
        icon={loginIcon}
        href={`${import.meta.env.VITE_APP_PLUS_APP}${
          isExcalidrawPlusSignedUser ? "" : "/sign-up"
        }?utm_source=signin&utm_medium=app&utm_content=hamburger`}
        className="highlighted"
      >
        {isExcalidrawPlusSignedUser ? "Sign in" : "Sign up"}
      </MainMenu.ItemLink>
      {isDevEnv() && (
        <MainMenu.Item
          icon={eyeIcon}
          onSelect={() => {
            if (window.visualDebug) {
              delete window.visualDebug;
              saveDebugState({ enabled: false });
            } else {
              window.visualDebug = { data: [] };
              saveDebugState({ enabled: true });
            }
            props?.refresh();
          }}
        >
          Visual Debug
        </MainMenu.Item>
      )}
      <MainMenu.Separator />
      <MainMenu.DefaultItems.Preferences />
      <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={props.theme} />
      <MainMenu.ItemCustom>
        <LanguageList style={{ width: "100%" }} />
      </MainMenu.ItemCustom>
      <MainMenu.DefaultItems.ChangeCanvasBackground />
    </MainMenu>
  );
});

import { useExplorer } from "../store/explorer";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";

/** Delete the selection, asking first when it's permanent or the user wants confirmation. */
export function requestDelete(permanent: boolean) {
  const explorer = useExplorer.getState();
  const count = explorer.selected.size;
  if (!count) return;
  const needsConfirm = permanent || useSettings.getState().confirmDelete;
  if (!needsConfirm) {
    explorer.deleteSelected(false);
    return;
  }
  const what = count === 1 ? `"${[...explorer.selected][0].split(/[\\/]/).pop()}"` : `${count} items`;
  useUi.getState().askConfirm({
    title: permanent ? "Delete permanently?" : "Move to Recycle Bin?",
    message: permanent
      ? `${what} will be deleted permanently. This can't be undone.`
      : `${what} will be moved to the Recycle Bin.`,
    confirmLabel: permanent ? "Delete permanently" : "Delete",
    danger: true,
    onConfirm: () => explorer.deleteSelected(permanent),
  });
}

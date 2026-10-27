import { Check, Info, Palette, Puzzle, Settings2, Tag, Trash, X } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import type { ViewMode } from "../lib/types";
import { MODULES, PRESETS, TIER_ORDER, isInstalled, presetState, type ModuleId } from "../modules/registry";
import { useExplorer } from "../store/explorer";
import { THEMES, useSettings, type ThemeId } from "../store/settings";
import { useUi, type SettingsTab } from "../store/ui";

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "General", icon: <Settings2 size={15} /> },
  { id: "appearance", label: "Appearance", icon: <Palette size={15} /> },
  { id: "modules", label: "Modules", icon: <Puzzle size={15} /> },
  { id: "tags", label: "Tags", icon: <Tag size={15} /> },
  { id: "about", label: "About", icon: <Info size={15} /> },
];

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      className={`toggle${checked ? " on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function General() {
  const s = useSettings();
  const dv = s.defaultView;
  const setDefault = (patch: Partial<typeof dv>) => s.update({ defaultView: { ...dv, ...patch } });
  return (
    <>
      <h4>Startup</h4>
      <Row label="Open Vault in">
        <select value={s.startLocation} onChange={(e) => s.update({ startLocation: e.target.value as typeof s.startLocation })}>
          <option value="this-pc">This PC</option>
          <option value="home">Home folder</option>
          <option value="last">Last folder</option>
        </select>
      </Row>
      <h4>Default view</h4>
      <p className="setting-hint block">
        Used by folders that don't have their own view yet. Changing the view inside a folder saves it for that folder only.
      </p>
      <Row label="Layout">
        <select value={dv.mode} onChange={(e) => setDefault({ mode: e.target.value as ViewMode })}>
          <option value="details">Details</option>
          <option value="list">List</option>
          <option value="grid">Grid</option>
        </select>
      </Row>
      <Row label="Folders first">
        <Toggle checked={dv.foldersFirst} onChange={(v) => setDefault({ foldersFirst: v })} />
      </Row>
      <Row label="Show hidden files">
        <Toggle checked={dv.showHidden} onChange={(v) => setDefault({ showHidden: v })} />
      </Row>
      <h4>Files</h4>
      <Row label="Confirm before moving to Recycle Bin" hint="Permanent deletes always ask first.">
        <Toggle checked={s.confirmDelete} onChange={(v) => s.update({ confirmDelete: v })} />
      </Row>
    </>
  );
}

const ACCENTS = ["#7c8cff", "#4fc3f7", "#5ee3c1", "#4dd0a1", "#a5d65c", "#ffc561", "#ffab5e", "#ff7a85", "#f06fc0", "#b388ff"];

function Appearance() {
  const s = useSettings();
  return (
    <>
      <h4>Theme</h4>
      <div className="theme-grid">
        {THEMES.map((t) => (
          <button
            key={t.id}
            className={`theme-card${s.theme === t.id ? " active" : ""}`}
            onClick={() => s.update({ theme: t.id as ThemeId })}
          >
            <div className="theme-swatch" data-theme={t.id}>
              <span className="sw-side" />
              <span className="sw-main">
                <span className="sw-row" />
                <span className="sw-row accent" />
                <span className="sw-row" />
              </span>
            </div>
            <span>{t.name}</span>
          </button>
        ))}
      </div>
      <h4>Accent colour</h4>
      <div className="accent-row">
        <button className={`accent-swatch default${s.accent == null ? " active" : ""}`} onClick={() => s.update({ accent: null })} title="Theme default">
          {s.accent == null && <Check size={12} />}
        </button>
        {ACCENTS.map((c) => (
          <button
            key={c}
            className={`accent-swatch${s.accent === c ? " active" : ""}`}
            style={{ background: c }}
            onClick={() => s.update({ accent: c })}
          >
            {s.accent === c && <Check size={12} />}
          </button>
        ))}
        <label className="accent-custom" title="Custom colour">
          <input type="color" value={s.accent ?? "#7c8cff"} onChange={(e) => s.update({ accent: e.target.value })} />
        </label>
      </div>
      <h4>Layout</h4>
      <Row label="Density">
        <div className="seg-small inline">
          {(["comfortable", "compact"] as const).map((d) => (
            <button key={d} className={s.density === d ? "active" : ""} onClick={() => s.update({ density: d })}>
              {d === "comfortable" ? "Comfortable" : "Compact"}
            </button>
          ))}
        </div>
      </Row>
    </>
  );
}

function Modules() {
  const s = useSettings();
  const tier = s.info?.tier ?? "full";
  const setModule = (id: ModuleId, v: boolean) => s.update({ modules: { ...s.modules, [id]: v } });
  return (
    <>
      <h4>Installation</h4>
      <p className="setting-hint block">
        This is the <b className="tier-inline">{tier}</b> build. The tier decides which modules are installed; installed
        modules can be switched on and off here at any time.
      </p>
      <h4>Presets</h4>
      <div className="preset-grid">
        {PRESETS.map((p) => (
          <button key={p.id} className="preset-card" onClick={() => s.update({ modules: presetState(p) })}>
            <div className="preset-name">{p.name}</div>
            <div className="preset-desc">{p.description}</div>
          </button>
        ))}
      </div>
      <h4>Modules</h4>
      <div className="module-list">
        {MODULES.map((m) => {
          const installed = isInstalled(m, tier);
          return (
            <div key={m.id} className={`module-row${installed ? "" : " unavailable"}`}>
              <div className="setting-text">
                <div className="setting-label">
                  {m.name}
                  {m.planned ? (
                    <span className="pill">Coming soon</span>
                  ) : (
                    TIER_ORDER.indexOf(m.tier) > 0 && <span className="pill subtle">{m.tier}+</span>
                  )}
                </div>
                <div className="setting-hint">
                  {!installed && !m.planned ? `Not installed in the ${tier} build. ` : ""}
                  {m.description}
                </div>
              </div>
              <Toggle checked={installed && s.modules[m.id]} disabled={!installed} onChange={(v) => setModule(m.id, v)} />
            </div>
          );
        })}
      </div>
    </>
  );
}

function Tags() {
  const tags = useExplorer((s) => s.tags);
  const refreshTags = useExplorer((s) => s.refreshTags);
  const refreshMeta = useExplorer((s) => s.refreshMeta);
  const askConfirm = useUi((s) => s.askConfirm);
  const [names, setNames] = useState<Record<number, string>>({});

  const save = async (id: number, name: string, color: string) => {
    await api.updateTag(id, name, color).catch((e) => useExplorer.getState().toast(String(e), "error"));
    await refreshTags();
  };

  return (
    <>
      <h4>Tags</h4>
      {tags.length === 0 && <p className="setting-hint block">No tags yet. Add one from the details panel.</p>}
      <div className="tag-admin">
        {tags.map((t) => (
          <div key={t.id} className="tag-admin-row">
            <label className="color-dot" style={{ background: t.color }}>
              <input type="color" value={t.color} onChange={(e) => save(t.id, t.name, e.target.value)} />
            </label>
            <input
              className="text-input"
              value={names[t.id] ?? t.name}
              onChange={(e) => setNames({ ...names, [t.id]: e.target.value })}
              onBlur={(e) => e.target.value.trim() && e.target.value !== t.name && save(t.id, e.target.value, t.color)}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
            <span className="faint">{t.count} file{t.count === 1 ? "" : "s"}</span>
            <button
              className="icon-btn small"
              title="Delete tag"
              onClick={() =>
                askConfirm({
                  title: `Delete tag "${t.name}"?`,
                  message: `It will be removed from ${t.count} file${t.count === 1 ? "" : "s"}. The files themselves are not touched.`,
                  confirmLabel: "Delete tag",
                  danger: true,
                  onConfirm: async () => {
                    await api.deleteTag(t.id);
                    await refreshTags();
                    await refreshMeta();
                  },
                })
              }
            >
              <Trash size={14} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function About() {
  const info = useSettings((s) => s.info);
  return (
    <>
      <div className="about-hero">
        <div className="about-logo">V</div>
        <div>
          <div className="about-name">Vault</div>
          <div className="setting-hint">A fast, modular file explorer</div>
        </div>
      </div>
      <Row label="Version">{info?.version}</Row>
      <Row label="Build tier">{info?.tier}</Row>
      <Row label="Data folder" hint="Metadata database (vault.db) lives here.">
        <button className="btn ghost small" onClick={() => info && api.openPath(info.dataDir)}>Open</button>
      </Row>
      <p className="setting-hint block selectable">{info?.dataDir}</p>
      <p className="setting-hint block">MIT License · github.com/Noxel43/Vault-file-explorer</p>
    </>
  );
}

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const tab = useUi((s) => s.settingsTab);
  const close = useUi((s) => s.closeSettings);
  const openSettings = useUi((s) => s.openSettings);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal settings"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
        }}
        tabIndex={-1}
      >
        <nav className="settings-nav">
          <div className="settings-title">Settings</div>
          {TABS.map((t) => (
            <button key={t.id} className={`side-item${tab === t.id ? " active" : ""}`} onClick={() => openSettings(t.id)}>
              {t.icon}
              <span className="side-label">{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <button className="icon-btn modal-close" onClick={close} title="Close (Esc)">
            <X size={16} />
          </button>
          {tab === "general" && <General />}
          {tab === "appearance" && <Appearance />}
          {tab === "modules" && <Modules />}
          {tab === "tags" && <Tags />}
          {tab === "about" && <About />}
        </div>
      </div>
    </div>
  );
}

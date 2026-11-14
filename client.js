// Browser half of @local/dsh-vault-tab: a right-Sidebar page type whose body
// is a second file tree over the Host route /vault-tab/list. Clicking a file
// opens dsh-resource://file/session/<id>/<absolute path>, which the shipped
// Document viewer already claims (reads follow the Session's file authority).
//
// The tree's markup and CSS mirror the shipped files tab (dsh-client-ui-sidebar-files
// FilesBody): rows are <button>.row inside <li>, levels nest as <ul> with an
// 18px left padding, header is 38px with a PathLabel-like root and the shared
// 28px tool button. Class names are renamed under the plugin prefix; only
// --dsw-alias-* / --dsh-* tokens are shared. Header path, folder icons, the
// refresh glyph and the per-extension FileTypeIcon coloring come from the
// shared primitives module when it resolves (see the Prim block), falling
// back to copied replicas. The Plugins-panel config card edits the row's
// config.root through configForms, the same path the built-in cards use.
window.__ModuleLoader__.load({
  id: '@local/dsh-vault-tab',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ID = '@local/dsh-vault-tab';
    const NS = 'vaultTab';
    const ENDPOINT = '/vault-tab/list';
    const L10N = {
      en: {
        'tab.title': 'Vault',
        'guide.title': 'Vault',
        'guide.description': 'A second file tree with its own root folder',
        reload: 'Reload',
        loading: 'Loading…',
        failed: 'Cannot read this folder',
        empty: 'Empty folder',
        other: 'Not a file or directory',
        missing: 'Vault not found',
        missingHint: 'Pick your folder in Plugins → Vault Tab (field “Vault path”), or create this path.',
        'config.title': 'Vault',
        'config.help': 'Absolute path of the folder this tab lists (empty: a Vault folder in the server home). Saving applies immediately; press Reload in the Vault tab to see the new tree.',
        'config.rootLabel': 'Vault path',
        'config.rootInvalid': 'Enter an absolute path, for example /workspace/Vault',
        'config.skillLabel': 'Vault setup skill',
        'config.skillHelp': 'Lets an AI create or adopt the vault folder with the vault_setup tool, guided by the vault-setup skill. Switch it off once the vault is set up: while on, it adds context to every session.',
        'config.notSet': 'No vault path set',
        'config.unavailable': 'The configuration entry is not available yet. Reload the page.',
        overridden: 'Overridden',
        reset: 'Reset',
        save: 'Save',
        discard: 'Discard',
        saveFailed: 'Saving failed. Try again.',
        'grant.title': 'Vault',
        'grant.on': 'on',
        'grant.off': 'off',
        'grant.editableHint': 'Grants writes inside the Vault folder, confined to the configured root.',
        'grant.readOnlyHint': 'Read Only blocks every write. Raise the permission to Workspace Write to grant it.',
        'grant.fullHint': 'Already covered by Full access.',
        'grant.customHint': 'Permission preset not recognised; the grant only applies to Workspace Write.',
        'grant.noProjection': 'The permission state is not available yet.',
        'grant.pending': 'Checking the Vault Grant…',
      },
    };

    // Host shared components. The browser module table registers
    // '@deepseek-ai/dsh-client-ui-primitives' as a static module (the very
    // instance shipped bundles import), so require resolves here too. It is
    // still an internal dependency that changes without notice across
    // upgrades: every use is guarded and falls back to the copied replicas
    // below, so a renamed primitive degrades the look, never the tab.
    let Prim = null;
    try {
      Prim = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (err) {
      Prim = null;
    }
    const PathLabel = (Prim && Prim.PathLabel) || null;
    const FileTypeIcon = (Prim && Prim.FileTypeIcon) || null;
    const classifyFileType = (Prim && Prim.classifyFileType) || null;
    const RealFolderClose = (Prim && Prim.IconFolderCloseRegular) || null;
    const RealFolderOpen = (Prim && Prim.IconFolderOpenRegular) || null;
    const RealRefresh = (Prim && Prim.IconRefreshOutlineRegular) || null;
    const RealTooltip = (Prim && Prim.Tooltip) || null;
    const SettingsValueField = (Prim && Prim.SettingsValueField) || null;
    const SettingsFormModel = (Prim && Prim.SettingsFormModel) || null;
    const RealButton = (Prim && Prim.Button) || null;

    /** Patch row id whose volatile config this card edits. */
    const CONFIG_ROW_ID = 'vault-tab';

    /** Staged text spec for the single root field: absolute path, ~ prefix, or clear. */
    const rootSpec = {
      field: 'root',
      format: function (value) {
        return value == null ? '' : String(value);
      },
      parse: function (text) {
        const trimmed = text.trim();
        if (!trimmed) return { kind: 'clear' };
        // The Host expands '~' for both roots; the card must not reject what the
        // profile patch would accept.
        if (trimmed !== '~' && !trimmed.startsWith('~/') && trimmed.charAt(0) !== '/') return void 0;
        return { kind: 'set', value: trimmed };
      },
    };

    /**
     * Staged spec for the setup-skill flag. The switch writes the two literals
     * 'on'/'off' through the same edit channel as the path field, so the Save /
     * Discard row stays the single commit point; only 'off' differs from the
     * default, and Reset restores the enabled skill.
     */
    const skillSpec = {
      field: 'skillSetup',
      format: function (value) {
        return value === false ? 'off' : 'on';
      },
      parse: function (text) {
        return { kind: 'set', value: String(text).trim().toLowerCase() !== 'off' };
      },
    };

    // Copied from the shipped FilesBody CSS (k-1LKG_* → dvt_*, tokens kept).
    const CSS = [
      '.dvt_root{height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);flex-direction:column;flex:auto;line-height:1.5;display:flex}',
      '.dvt_header{box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;align-items:center;gap:4px;height:38px;padding:0 6px 0 16px;display:flex}',
      '.dvt_path{margin-right:12px;min-width:0;direction:rtl;text-align:left;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;unicode-bidi:isolate}',
      '.dvt_pathHost{margin-right:12px}',
      '.dvt_body{scrollbar-gutter:stable;flex:auto;min-height:0;margin-right:2px;padding:8px 0 8px 8px;overflow:auto}',
      '.dvt_body::-webkit-scrollbar-track{margin:2px}',
      '.dvt_level{margin:0;padding:0;list-style:none}',
      '.dvt_level .dvt_level{padding-left:18px}',
      '.dvt_item{margin:0;padding:0}',
      '.dvt_row{width:100%;min-width:0;color:inherit;font:inherit;text-align:left;border-radius:var(--dsw-radius-md);cursor:pointer;background:0 0;border:0;align-items:center;gap:6px;padding:5px 10px;display:flex}',
      '.dvt_row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dvt_icon{color:var(--dsw-alias-label-tertiary);flex:none}',
      '.dvt_fileIcon{flex:none}',
      '.dvt_sheet{color:var(--dsw-alias-label-secondary);flex:none}',
      '.dvt_name{white-space:nowrap;text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '.dvt_other{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.dvt_other:hover{background:0 0}',
      '.dvt_note{color:var(--dsw-alias-label-tertiary);margin:0;padding:3px 10px;font-size:12px}',
      '.dvt_empty{flex-direction:column;flex:auto;justify-content:center;align-items:center;gap:2px;padding:24px;display:flex}',
      '.dvt_emptyIcon{color:var(--dsw-alias-label-tertiary);opacity:.55;margin-bottom:6px}',
      '.dvt_emptyTitle{color:var(--dsw-alias-label-primary);font-weight:600;font-size:15px;margin:0}',
      '.dvt_emptyHint{color:var(--dsw-alias-label-secondary);text-align:center;font-size:var(--dsh-content-font-size-secondary,13px);max-width:38ch;margin:0;line-height:1.5}',
      '.dvt_emptyPath{color:var(--dsw-alias-label-tertiary);font-family:var(--dsh-font-family-mono, monospace);text-align:center;font-size:12px;overflow-wrap:anywhere;max-width:38ch;margin:4px 0 0}',
      '.dvt_status{flex-direction:column;padding:12px 10px;display:flex}',
      '.dvt_statusLine{color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);margin:0;line-height:1.6}',
      '.dvt_tool{width:28px;height:28px;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);cursor:pointer;background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:6px;line-height:1;display:inline-flex}',
      '.dvt_tool svg{width:15px;height:15px}',
      '.dvt_tool:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dvt_cfg{gap:10px;max-width:520px;display:flex;flex-direction:column}',
      '.dvt_cfgHelp{color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);margin:0;line-height:1.6}',
      '.dvt_cfgActions{align-items:center;gap:8px;display:flex}',
      '.dvt_cfgFailed{color:var(--dsw-alias-status-danger, #d33);font-size:12px}',
      '.dvt_titleIcon{flex:none}',
      '.dvt_switchRow{align-items:flex-start;gap:10px;display:flex}',
      '.dvt_switch{width:36px;height:20px;border-radius:10px;cursor:pointer;border:0;flex:none;padding:0;position:relative;background:var(--dsw-alias-state-idle-primary,#8e8e93)}',
      '.dvt_switch:disabled{cursor:default;opacity:.5}',
      '.dvt_switchOn{background:var(--dsw-alias-brand-primary,#4a7dff)}',
      '.dvt_switchKnob{width:16px;height:16px;border-radius:50%;display:block;background:var(--dsw-alias-bg-overlay,#fff);top:2px;left:2px;position:absolute;transition:left .12s ease-out}',
      '.dvt_switchOn .dvt_switchKnob{left:18px}',
      '.dvt_switchText{min-width:0;flex-direction:column;gap:2px;display:flex}',
      '.dvt_switchHead{align-items:center;gap:6px;display:flex}',
      '.dvt_switchLabel{color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px)}',
      '.dvt_switchTag{color:var(--dsw-alias-label-tertiary);font-size:11px}',
    ].join('\n');

    const SVG = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true };

    /** FolderCloseRegular copy (stroke, 16px). */
    function FolderClose(props) {
      return h('svg', Object.assign({}, SVG, { className: props.className, strokeWidth: 1 }),
        h('path', { d: 'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z', stroke: 'currentColor' }),
        h('path', { d: 'M3.63501 7.66614H12.3647', stroke: 'currentColor' }));
    }

    /** FolderOpenRegular copy (fill, 16px). */
    function FolderOpen(props) {
      return h('svg', Object.assign({}, SVG, { className: props.className }),
        h('path', { d: 'M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z', fill: 'currentColor', opacity: '0.16' }),
        h('path', { d: 'M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z', fill: 'currentColor' }),
        h('path', { d: 'M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z', fill: 'currentColor' }));
    }

    /** Neutral document sheet, matching the stroke-icon family (FileTypeIcon copy is not shareable). */
    function FileSheet(props) {
      return h('svg', Object.assign({}, SVG, { className: props.className, strokeWidth: 1 }),
        h('path', { d: 'M9.5 1.5H4.5C3.67157 1.5 3 2.17157 3 3V13C3 13.8284 3.67157 14.5 4.5 14.5H11.5C12.3284 14.5 13 13.8284 13 13V5L9.5 1.5Z', stroke: 'currentColor' }),
        h('path', { d: 'M9.5 1.5V4.5H13', stroke: 'currentColor' }));
    }

    /** IconRefreshOutlineRegular copy. */
    function IconRefresh(props) {
      return h('svg', Object.assign({}, SVG, { strokeWidth: 1 }),
        h('path', { d: 'M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1', stroke: 'currentColor' }),
        h('path', { d: 'M14.4999 1.5V5.1H10.8999', stroke: 'currentColor' }));
    }

    function VaultIcon(props) {
      const size = props && props.size ? props.size : 16;
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, className: props && props.className, style: { display: 'block', flex: 'none' } },
        h('path', {
          d: 'M1.75 3.5A1.25 1.25 0 0 1 3 2.25h2.35c.4 0 .78.16 1.06.44l.9.9H13a1.25 1.25 0 0 1 1.25 1.25v6.91A1.5 1.5 0 0 1 12.75 13.25h-9A2 2 0 0 1 1.75 11.25V3.5Z',
          fill: '#2f9e8f',
        }),
        h('circle', { cx: 8.6, cy: 8.9, r: 1.9, fill: 'none', stroke: '#ffffff', strokeWidth: 1.1 }),
        h('circle', { cx: 8.6, cy: 8.9, r: 0.5, fill: '#ffffff' }),
      );
    }

    /** Build dsh-resource://file/session/<id>/<absolute path> with component-encoded segments. */
    function sessionFileAddress(sessionId, absolutePath) {
      const posix = String(absolutePath).replace(/\\/g, '/');
      return 'dsh-resource://file/session/' + encodeURIComponent(sessionId) + '/' + posix.split('/').map(encodeURIComponent).join('/');
    }

    function VaultBody(props) {
      const sessionId = props.sessionId;
      const t = props.t;
      const [root, setRoot] = React.useState('');
      const [levels, setLevels] = React.useState({});
      const [expanded, setExpanded] = React.useState({});
      const [missingRoot, setMissingRoot] = React.useState(null);
      const alive = React.useRef(true);
      React.useEffect(function () {
        return function () {
          alive.current = false;
        };
      }, []);

      function writeLevel(rel, value) {
        setLevels(function (s) {
          const n = Object.assign({}, s);
          n[rel] = value;
          return n;
        });
      }

      function load(rel) {
        writeLevel(rel, { state: 'loading' });
        fetch(ENDPOINT + '?path=' + encodeURIComponent(rel), { credentials: 'same-origin' })
          .then(function (r) {
            return r.ok ? r.json() : Promise.reject(new Error('http ' + r.status));
          })
          .then(function (data) {
            if (!alive.current) return;
            setMissingRoot(data.missing ? data.root || '' : null);
            if (data.root) setRoot(data.root);
            writeLevel(rel, { state: 'ready', entries: data.entries || [], truncated: !!data.truncated });
          })
          .catch(function () {
            if (alive.current) writeLevel(rel, { state: 'failed' });
          });
      }

      React.useEffect(function () {
        load('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      function reload() {
        load('');
        Object.keys(expanded).forEach(load);
      }

      function toggle(rel) {
        if (expanded[rel]) {
          setExpanded(function (e) {
            const n = Object.assign({}, e);
            delete n[rel];
            return n;
          });
          return;
        }
        setExpanded(function (e) {
          const n = Object.assign({}, e);
          n[rel] = true;
          return n;
        });
        if (!levels[rel]) load(rel);
      }

      const tabInfo = props.useTabInfo();
      function openFile(entryPath) {
        if (!root) return;
        const abs = root === '/' ? '/' + entryPath : root + '/' + entryPath;
        tabInfo.tab.actions.openResource(sessionFileAddress(sessionId, abs));
      }

      /** One entry row: folder toggle, file open, or a greyed non-file, mirroring FilesBody's Entry. */
      function Entry(props) {
        const entry = props.entry;
        const isOpen = !!expanded[entry.path];
        if (entry.kind === 'directory') {
          return h(
            'li',
            { className: 'dvt_item', key: entry.name },
            h(
              'button',
              {
                type: 'button',
                className: 'dvt_row',
                'aria-expanded': isOpen,
                onClick: function () {
                  toggle(entry.path);
                },
              },
              h(isOpen ? RealFolderOpen || FolderOpen : RealFolderClose || FolderClose, { className: 'dvt_icon' }),
              h('span', { className: 'dvt_name' }, entry.name),
            ),
            isOpen
              ? h('ul', { className: 'dvt_level' }, h(Level, { rel: entry.path }))
              : null,
          );
        }
        if (entry.kind === 'file') {
          return h(
            'li',
            { className: 'dvt_item', key: entry.name },
            h(
              'button',
              {
                type: 'button',
                className: 'dvt_row',
                onClick: function () {
                  openFile(entry.path);
                },
              },
              FileTypeIcon && classifyFileType
                ? h(FileTypeIcon, { kind: classifyFileType(entry.name), size: 16, className: 'dvt_fileIcon' })
                : h(FileSheet, { className: 'dvt_sheet' }),
              h('span', { className: 'dvt_name' }, entry.name),
            ),
          );
        }
        return h(
          'li',
          { className: 'dvt_item', key: entry.name },
          h(
            'span',
            { className: 'dvt_row dvt_other', 'aria-disabled': 'true', title: t('other') },
            h('span', { className: 'dvt_name' }, entry.name),
          ),
        );
      }

      /** One directory's rows: its state while listing, its entries once listed (FilesBody's Level). */
      function Level(lprops) {
        const level = levels[lprops.rel];
        if (!level || level.state === 'loading') return h('li', { className: 'dvt_note' }, t('loading'));
        if (level.state === 'failed') return h('li', { className: 'dvt_note' }, t('failed'));
        return [
          level.entries.length === 0 ? h('li', { className: 'dvt_note', key: 'empty' }, t('empty')) : null,
          level.entries.map(function (entry) {
            return h(Entry, { key: entry.path, entry });
          }),
          level.truncated ? h('li', { className: 'dvt_note', key: 'truncated' }, '…') : null,
        ];
      }

      const refreshButton = h(
        'button',
        { type: 'button', className: 'dvt_tool', 'aria-label': t('reload'), title: t('reload'), onClick: reload },
        h(RealRefresh || IconRefresh, null),
      );
      // Host header wraps reload in a Tooltip (label + shortcut keys).
      const reloadControl = RealTooltip
        ? h(
            RealTooltip,
            {
              label: t('reload'),
              shortcutKeys: tabInfo.tab.refreshShortcut && tabInfo.tab.refreshShortcut.keys,
              side: 'bottom',
              delayMs: 500,
            },
            refreshButton,
          )
        : refreshButton;

      return h(
        'div',
        { className: 'dvt_root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dvt_header' },
          // PathLabel reale quando le primitives rispondono; altrimenti la replica.
          PathLabel
            ? h(PathLabel, { path: root, className: 'dvt_pathHost', 'data-files-path': true })
            : h('span', { className: 'dvt_path', title: root }, root ? '\u202D' + root + '\u202C' : ''),
          reloadControl,
        ),
        h(
          'div',
          { className: 'dvt_body' },
          missingRoot !== null
            ? h(
                'div',
                { className: 'dvt_empty' },
                h(VaultIcon, { size: 36, className: 'dvt_emptyIcon' }),
                h('p', { className: 'dvt_emptyTitle' }, t('missing')),
                h('p', { className: 'dvt_emptyHint' }, t('missingHint')),
                missingRoot ? h('p', { className: 'dvt_emptyPath' }, missingRoot) : null,
              )
            : h('ul', { className: 'dvt_level' }, h(Level, { rel: '' })),
        ),
      );
    }

    /** Store over the staged config form, rebuilt at each activation. */
    let cardStore = null;

    /**
     * Configuration card inline on this bundle's page in the Plugins panel
     * (`plugins.bundle.config`, keyed by package name, between description
     * and components). The owner passes no form here, so the card drives
     * the row's served config namespace through SettingsFormModel, exactly
     * like the built-in cards do.
     */
    function VaultBundleConfig(props) {
      const t = props.t;
      const snap = React.useSyncExternalStore(cardStore.subscribe, cardStore.getSnapshot);
      const shell = snap.shell;
      const field = snap.root;
      // The Host row supplies this field; a stale schema still renders a switch.
      const skillField = snap.skill || { text: 'on', overridden: false, invalid: false };
      return h(
        'div',
        { className: 'dvt_cfg' },
        h('style', null, CSS),
        h('p', { className: 'dvt_cfgHelp' }, t('config.help')),
        h(SettingsValueField, {
          id: 'plugin-config-vault-root',
          label: t('config.rootLabel'),
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          invalidLabel: t('config.rootInvalid'),
          text: field.text,
          overridden: field.overridden,
          invalid: field.invalid,
          disabled: !shell.writable || shell.saving,
          onEdit: function (text) {
            props.edit('root', text);
          },
          onReset: function () {
            props.resetField('root');
          },
        }),
        h(
          'div',
          { className: 'dvt_switchRow' },
          h(
            'button',
            {
              id: 'plugin-config-vault-skill',
              type: 'button',
              role: 'switch',
              'aria-checked': skillField.text === 'off' ? 'false' : 'true',
              className: 'dvt_switch' + (skillField.text === 'off' ? '' : ' dvt_switchOn'),
              disabled: !shell.writable || shell.saving,
              onClick: function () {
                props.edit('skillSetup', skillField.text === 'off' ? 'on' : 'off');
              },
            },
            h('span', { className: 'dvt_switchKnob' }),
          ),
          h(
            'span',
            { className: 'dvt_switchText' },
            h(
              'span',
              { className: 'dvt_switchHead' },
              h('span', { className: 'dvt_switchLabel' }, t('config.skillLabel')),
              skillField.overridden ? h('span', { className: 'dvt_switchTag' }, t('overridden')) : null,
            ),
            h('p', { className: 'dvt_cfgHelp' }, t('config.skillHelp')),
          ),
        ),
        shell.dirty
          ? h(
              'div',
              { className: 'dvt_cfgActions' },
              h(
                RealButton || 'button',
                { variant: 'primary', disabled: shell.saving || shell.invalid, onClick: props.save },
                t('save'),
              ),
              h(
                RealButton || 'button',
                { variant: 'outline', disabled: shell.saving, onClick: props.discard },
                t('discard'),
              ),
              shell.failed ? h('span', { className: 'dvt_cfgFailed' }, t('saveFailed')) : null,
            )
          : null,
      );
    }

    // ── Composer chip: Vault Grant ──────────────────────────────────────────
    // Visual preview of the control specified in task/vault-write-grant.md:
    // display only. No grant is stored, no command is sent, no Host route is
    // called. Geometry, type size and interaction states copy the shipped
    // permission trigger (28px row, 13px/500, radius-sm, hover bg, focus ring,
    // dimmed disabled); classes are renamed under dvt_grant* and only
    // --dsw-alias-* tokens are referenced, so a renamed token fades the look
    // and never breaks the composer.
    const GRANT_CSS = [
      '.dvt_grant{border-radius:var(--dsw-radius-sm);min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;outline:none;align-items:center;gap:5px;padding:0 6px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}',
      '.dvt_grant:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dvt_grant:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.dvt_grant:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
      '.dvt_grantIcon{flex:none;display:inline-flex}',
      '.dvt_grantLabel{white-space:nowrap;text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '.dvt_grantDot{border-radius:50%;flex:none;width:6px;height:6px;background:var(--dsw-alias-state-idle-primary)}',
      '.dvt_grantOn{color:var(--dsw-alias-label-primary)}',
      '.dvt_grantOn .dvt_grantDot{background:var(--dsw-alias-state-success-primary)}',
      '.dvt_grantBusy{opacity:.55}',
      '@container (width<=460px){.dvt_grant .dvt_grantLabel{display:none}}',
    ].join('');

    /** Host answer of "may this session write to the vault", shared with the tool. */
    const GRANT_ENDPOINT = '/vault-tab/grant';

    function GrantIcon(props) {
      const size = props && props.size ? props.size : 14;
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          style: { display: 'block' },
        },
        h('rect', { x: 3.2, y: 7, width: 9.6, height: 6.1, rx: 1.6 }),
        props && props.open
          ? h('path', { d: 'M5.1 7V5.2A2.7 2.7 0 0 1 10.3 4.4' })
          : h('path', { d: 'M5.1 7V5a2.9 2.9 0 0 1 5.8 0v2' }),
      );
    }

    /**
     * The chip. Its answer comes from the same Host resolver that gates the
     * `vault_write` tool (`GET /vault-tab/grant`), so the control can never show
     * a permission the tool would refuse. The click runs the human
     * `/vault-write` command through the session's own binding: the grant stays
     * out of the model's reach, and no route ever changes it.
     *
     * Display rule (decided): Read Only → off, locked. Workspace Write → the
     * session's stored value, editable, and kept while the mode changes and the
     * session lives. Full access → on, locked.
     */
    function VaultGrantChip(props) {
      const t = props.t;
      const sessionId = props.sessionId;
      const sessions = props.sessions;
      const projection = props.useProjection('permissions');
      const [state, setState] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const refresh = React.useCallback(function () {
        if (!sessionId) return;
        fetch(GRANT_ENDPOINT + '?session=' + encodeURIComponent(sessionId), { credentials: 'same-origin' })
          .then(function (response) {
            return response.ok ? response.json() : Promise.reject(new Error('grant ' + response.status));
          })
          .then(function (body) {
            setState(body && typeof body.allowed === 'boolean' ? body : null);
          })
          .catch(function () {
            setState(null);
          });
      }, [sessionId]);
      React.useEffect(refresh, [refresh]);
      // The permission projection is not the source of truth here, only the
      // signal that the server's verdict may have changed.
      const preset = projection && projection.currentValue;
      React.useEffect(refresh, [refresh, preset]);

      const toggle = function () {
        if (!state || !state.editable || busy) return;
        const binding = sessionId && sessions ? sessions.binding(sessionId) : null;
        const session = binding && binding.session;
        if (!session || typeof session.command !== 'function') return;
        setBusy(true);
        Promise.resolve()
          .then(function () {
            return session.command('/vault-write ' + (state.allowed ? 'off' : 'on'));
          })
          .catch(function () {
            // The command reports its own failure in the composer flow; the
            // refetch below shows the unchanged state, so nothing is hidden.
          })
          .then(refresh)
          .then(function () {
            setBusy(false);
          });
      };

      const allow = !!(state && state.allowed);
      const editable = !!(state && state.editable);
      const mode = (state && state.mode) || '';
      const hint = !state
        ? t('grant.noProjection')
        : mode === 'read-only'
          ? t('grant.readOnlyHint')
          : editable
            ? t('grant.editableHint')
            : mode === 'danger-full-access'
              ? t('grant.fullHint')
              : t('grant.customHint');
      return h(
        React.Fragment,
        null,
        h('style', null, GRANT_CSS),
        h(
          'button',
          {
            type: 'button',
            className: 'dvt_grant' + (allow ? ' dvt_grantOn' : '') + (busy ? ' dvt_grantBusy' : ''),
            role: 'switch',
            'aria-checked': allow,
            disabled: !editable || busy,
            title: hint + (state && state.root ? ' · ' + state.root : ''),
            onClick: toggle,
          },
          h(GrantIcon, { open: allow }),
          h('span', { className: 'dvt_grantLabel' }, t('grant.title') + ': ' + (state ? (allow ? t('grant.on') : t('grant.off')) : '…')),
          h('span', { className: 'dvt_grantDot', 'aria-hidden': true }),
        ),
      );
    }

    return {
      // configForms is a real dependency here: an undeclared ctx access does
      // not resolve in the browser fiber. It ships with the GUI settings
      // stack; the client half only runs in a GUI profile anyway.
      inject: ['slots', 'locale', 'sidebarRightTabs', 'configForms', 'sessions'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(function () {
          return ctx.locale.register(NS, L10N);
        }, 'vault-tab: dictionaries');
        // Seat: the compact controls right after the permission picker in the
        // composer tool row (`conversation.input.left`, rendered immediately
        // after the `.modes` group that owns `conversation.input.permission`).
        ctx.effect(function () {
          return ctx.slots.inject('conversation.input.left', function () {
            return ctx.slots.register(
              {
                name: 'conversation.input.left',
                id: 'vault-grant',
                order: 10,
                locale: NS,
                // `sessions` drives the human command; the seat already hands the
                // component its own `sessionId`.
                inject: function () {
                  return { sessions: ctx.sessions };
                },
              },
              VaultGrantChip,
            );
          });
        }, 'vault-tab: composer grant chip');
        ctx.effect(function () {
          return ctx.sidebarRightTabs.register({
            id: ID,
            kind: 'vault-files',
            keepMounted: true,
            title: function () {
              return t('tab.title');
            },
            guide: [
              {
                id: 'vault-root',
                order: 15,
                title: function () {
                  return t('guide.title');
                },
                description: function () {
                  return t('guide.description');
                },
                icon: VaultIcon,
              },
            ],
          });
        }, 'vault-tab: tab type');
        ctx.effect(function () {
          return ctx.slots.inject('sidebar.right.pane.tab', function () {
            return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID, locale: NS }, VaultBody);
          });
        }, 'vault-tab: tab body');
        ctx.effect(function () {
          return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
            return ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: ID }, function VaultTitle() {
              return h(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                h(VaultIcon, { size: 16 }),
                t('tab.title'),
              );
            });
          });
        }, 'vault-tab: tab title');
        // Config card inline on the bundle's page in the Plugins panel. The
        // bundle-level slot passes no form, so drive the row's served config
        // namespace here; everything is guarded — without the settings UI or
        // the primitives the card is simply absent, the tab stays intact.
        let configForms = null;
        try {
          configForms = ctx.configForms || null;
        } catch (err) {
          configForms = null;
        }
        if (configForms && SettingsFormModel && SettingsValueField) {
          const formModel = new SettingsFormModel(configForms.get(CONFIG_ROW_ID), [rootSpec, skillSpec]);
          cardStore = formModel.bind(function () {
            return { shell: formModel.shell(), root: formModel.field('root'), skill: formModel.field('skillSetup') };
          });
          ctx.effect(function () {
            return function () {
              if (typeof formModel.dispose === 'function') formModel.dispose();
            };
          }, 'vault-tab: config form subscription');
          if (typeof configForms.whileServed === 'function') {
            ctx.effect(function () {
              return configForms.whileServed([CONFIG_ROW_ID], function () {
                return ctx.slots.inject('plugins.bundle.config', function () {
                  return ctx.slots.register(
                    {
                      name: 'plugins.bundle.config',
                      key: ID,
                      locale: NS,
                      inject: function () {
                        return formModel.actions();
                      },
                    },
                    VaultBundleConfig,
                  );
                });
              });
            }, 'vault-tab: bundle config card');
          }
        }
      },
    };
  },
});

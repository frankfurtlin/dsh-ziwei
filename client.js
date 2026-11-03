/**
 * dsh-ziwei —— client 半（浏览器）。
 *
 * 手写 ModuleLoader 工厂，不经打包：只依赖宿主已提供的 react / react/jsx-runtime，
 * 用 h() 直接构造元素。做两件事：
 *   1. 在侧栏「插件」组的 panellist 座位注册一行「紫微斗数」（order 20，落在
 *      Automation tasks(10) 与 Skill Center(30) 之间）。
 *   2. 在 main 座位注册 keyed 面板页：同源 iframe 指向宿主反代的 /ziwei/，
 *      并把 iframe 上报的盘面摘要组装成 prompt，一键开新会话交给 DSH Agent。
 */
window.__ModuleLoader__.load({
  id: "dsh-ziwei",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;

    /** 侧栏行 id —— 同时是 main 座位的 key 与图标上的 data 锚点。 */
    var PANEL_ID = "ziwei";
    /** 侧栏顺序：Automation tasks = 10，Skill Center = 30。 */
    var PANEL_ORDER = 20;

    var COLORS = {
      border: "color-mix(in srgb, currentColor 18%, transparent)",
      muted: "color-mix(in srgb, currentColor 58%, transparent)",
      chip: "color-mix(in srgb, currentColor 8%, transparent)",
    };

    /** 问盘的默认问题（用户没填时使用）。 */
    var DEFAULT_QUESTION =
      "请先做整体解读：命格与命宫主星格局、三方四正、生年四化落宫、当前大限与今年的重点，最后给 3 条可执行的建议。";

    /**
     * 面板里可切换的三张页面（同一个应用，不同路由）。
     * 合盘页只有「调 AI 接口」这一条路，而应用内的 AI 已经去掉（解读统一由 DSH 的模型做），
     * 所以这里只保留能在本地独立成立的三个视图。
     */
    var VIEWS = [
      { key: "chart", label: "排盘", path: "ziwei/chart", title: "紫微斗数排盘" },
      { key: "library", label: "古籍", path: "ziwei/library", title: "紫微斗数古籍库" },
      { key: "knowledge", label: "百科", path: "ziwei/knowledge", title: "紫微斗数百科" },
    ];

    /** 读宿主（DSH 外壳）当前配色：外壳用 color-scheme 表达浅色/深色。 */
    function hostTheme() {
      try {
        var scheme = getComputedStyle(document.documentElement).colorScheme || "";
        return scheme.indexOf("dark") !== -1 ? "dark" : "light";
      } catch (error) {
        return "light";
      }
    }

    /**
     * 组装交给 Agent 的 prompt。
     * @param {string} digest 命盘摘要（app 侧 digestChart 生成）
     * @param {string} question 用户的补充问题
     */
    function buildPrompt(digest, question) {
      return [
        "请用紫微斗数（三合派 / 倪师体系）为我解读下面这张命盘。",
        "",
        "【命盘】",
        digest,
        "",
        "【我的问题】",
        question && question.trim() ? question.trim() : DEFAULT_QUESTION,
        "",
        "【要求】",
        "- 用中文，条理清晰，用小标题分节；",
        "- 提到星曜时说明亮度与四化，提到宫位时标出地支；",
        "- 每个判断都落到盘面证据上，不要泛泛而谈的运势套话。",
      ].join("\n");
    }

    /** 侧栏行图标：罗盘 / 命盘意象。 */
    function ZiweiPanelIcon(props) {
      var size = (props && props.size) || 16;
      return h(
        "svg",
        {
          "data-dsh-panel-entry": PANEL_ID,
          viewBox: "0 0 16 16",
          width: size,
          height: size,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.3",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("circle", { cx: "8", cy: "8", r: "5.6" }),
        h("circle", { cx: "8", cy: "8", r: "1.15", fill: "currentColor", stroke: "none" }),
        h("path", { d: "M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7" }),
        h("path", { d: "M10.7 5.3 8.9 8.9 5.3 10.7 7.1 7.1z" }),
      );
    }

    function ToolbarButton(props) {
      var disabled = !!props.disabled;
      return h(
        "button",
        {
          type: "button",
          onClick: props.onClick,
          disabled: disabled,
          title: props.title || "",
          style: {
            padding: "5px 12px",
            borderRadius: 7,
            border: "1px solid " + COLORS.border,
            background: props.primary && !disabled ? "color-mix(in srgb, currentColor 12%, transparent)" : "transparent",
            color: "inherit",
            font: "inherit",
            fontSize: 13,
            cursor: disabled ? "default" : "pointer",
            opacity: disabled ? 0.45 : 1,
            whiteSpace: "nowrap",
          },
        },
        props.children,
      );
    }

    /**
     * 主面板页：工具条 + 同源 iframe。
     * @param {object} props 框架 main 座位 share + 本插件注入的面（askDsh）。
     */
    function ZiweiPanelPage(props) {
      var askDsh = props.askDsh;
      var iframeRef = react.useRef(null);
      var [digest, setDigest] = react.useState("");
      var [question, setQuestion] = react.useState("");
      var [loaded, setLoaded] = react.useState(false);
      var [sent, setSent] = react.useState(false);
      var [copied, setCopied] = react.useState(false);

      // 当前在看哪一页：排盘 / 古籍 / 百科。默认落排盘页。
      var [view, setView] = react.useState("chart");

      function viewUrl(key) {
        var item = null;
        for (var i = 0; i < VIEWS.length; i += 1) {
          if (VIEWS[i].key === key) item = VIEWS[i];
        }
        if (!item) item = VIEWS[0];
        try {
          var target = new URL(item.path, document.baseURI);
          target.searchParams.set("theme", hostTheme());
          return target.href;
        } catch (error) {
          return "/" + item.path + "?theme=light";
        }
      }

      // 只跟着 view 走；主题变化通过 postMessage 推，避免每次渲染重载 iframe。
      var src = react.useMemo(function () {
        return viewUrl(view);
      }, [view]);
      var viewTitle = react.useMemo(function () {
        for (var i = 0; i < VIEWS.length; i += 1) {
          if (VIEWS[i].key === view) return VIEWS[i].title;
        }
        return VIEWS[0].title;
      }, [view]);

      function switchView(key) {
        if (key === view) return;
        setView(key);
        setLoaded(false);
        setSent(false);
      }

      var homeHref = react.useMemo(function () {
        try {
          return new URL("ziwei/", document.baseURI).href;
        } catch (error) {
          return "/ziwei/";
        }
      }, []);

      // 宿主切浅色/深色时把新主题推给内嵌页：只 postMessage，不重载，盘面不丢。
      react.useEffect(function () {
        var current = hostTheme();
        var observer = null;
        try {
          observer = new MutationObserver(function () {
            var next = hostTheme();
            if (next === current) return;
            current = next;
            var frame = iframeRef.current;
            if (frame && frame.contentWindow) {
              frame.contentWindow.postMessage({ type: "dsh-ziwei:theme", theme: next }, window.location.origin);
            }
          });
          observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["style", "class", "data-theme", "data-ds-theme-source"],
          });
        } catch (error) {}
        return function () {
          if (observer) observer.disconnect();
        };
      }, []);

      // 把宠物浮层在 iframe 内遮挡的区域同步给排盘页：
      // 否则面板底部的「追问」按钮会被宠物盖住，真实点击打不到。
      react.useEffect(
        function () {
          var frame = iframeRef.current;
          if (!loaded || !frame) return undefined;
          function push() {
            var win = frame.contentWindow;
            if (!win) return;
            var insets = petInsets(frame);
            win.postMessage(
              { type: "dsh-ziwei:insets", bottom: insets.bottom, right: insets.right },
              window.location.origin,
            );
          }
          push();
          var timer = window.setInterval(push, 2000);
          window.addEventListener("resize", push);
          return function () {
            window.clearInterval(timer);
            window.removeEventListener("resize", push);
          };
        },
        [loaded],
      );

      react.useEffect(function () {
        function onMessage(event) {
          if (event.origin !== window.location.origin) return;
          var data = event.data;
          if (!data || data.type !== "dsh-ziwei:chart") return;
          var frame = iframeRef.current;
          if (frame && event.source && event.source !== frame.contentWindow) return;
          setDigest(typeof data.summary === "string" ? data.summary : "");
          setSent(false);
        }
        window.addEventListener("message", onMessage);
        return function () {
          window.removeEventListener("message", onMessage);
        };
      }, []);

      function reload() {
        var frame = iframeRef.current;
        if (frame) frame.src = src;
        setLoaded(false);
      }

      function askAgent() {
        if (!digest) return;
        var prompt = buildPrompt(digest, question);
        // 会话草稿在宿主的 Lexical 编辑器里，插件无法直接写；startSession 的 prompt
        // 选项在本版本不落到编辑器，所以同时把命盘文本放进剪贴板作为兜底。
        copyText(prompt).then(setCopied);
        Promise.resolve(askDsh(prompt)).then(function (ok) {
          if (ok) setSent(true);
          if (ok) fillComposer(prompt);
        });
      }

      /**
       * 会话草稿在宿主的 Lexical 编辑器里，插件拿不到写入 API，
       * 于是等新会话的输入框出现后，用浏览器原生的插入命令把文本「粘」进去
       * （等价于用户粘贴，可撤销）；失败则退化为只给剪贴板。
       */
      /** 找到会话输入框：优先 Lexical 编辑器本体，退 textarea。 */
      function findComposer() {
        var selectors = [
          '[data-lexical-editor="true"]',
          '[contenteditable="true"][role="textbox"]',
          '[contenteditable="true"]',
          'textarea',
        ];
        for (var i = 0; i < selectors.length; i += 1) {
          var node = document.querySelector(selectors[i]);
          if (node) return node;
        }
        return null;
      }

      /** 把 text 插进当前编辑器光标处；返回是否真的写进去了。 */
      function insertIntoEditor(editor, text) {
        try {
          if (editor.tagName === 'TEXTAREA') {
            editor.focus();
            editor.value = text;
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          }
          editor.focus();
          var selection = window.getSelection();
          var range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
          var ok = document.execCommand('insertText', false, text);
          if (!ok) {
            document.execCommand('insertHTML', false, text.split('\n').map(function (line) {
              return line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            }).join('<br>'));
          }
          return editor.innerText.replace(/\s+/g, ' ').indexOf(text.slice(0, 12)) !== -1;
        } catch (error) {
          return false;
        }
      }

      /**
       * 等新会话的输入框出现并写入 prompt。
       *
       * 会议话页有时要好几秒才挂载（工作区多、会话列表在加载），所以轮询 15 秒；
       * 写进去后还读回来校验一次，React 把内容重置掉就再写一遍。
       */
      function fillComposer(text) {
        var deadline = Date.now() + 15000;
        var needle = text.slice(0, 12);
        return new Promise(function (resolve) {
          var tries = 0;
          function attempt() {
            var editor = findComposer();
            if (!editor) {
              if (Date.now() > deadline) return resolve(false);
              return setTimeout(attempt, 250);
            }
            var current =
              editor.tagName === 'TEXTAREA'
                ? String(editor.value || '')
                : String(editor.innerText || '');
            if (current.replace(/\s+/g, ' ').indexOf(needle) !== -1) return resolve(true);
            insertIntoEditor(editor, text);
            tries += 1;
            if (tries > 6) return resolve(false);
            setTimeout(attempt, 500);
          }
          attempt();
        });
      }

      /** 把文本写入剪贴板（失败时不阻塞主流程）。 */
      function copyText(text) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
          }
        } catch (error) {}
        return Promise.resolve(false);
      }

      var hasChart = digest.length > 0;

      return h(
        "div",
        {
          "data-dsh-ziwei-view": "",
          "data-dsh-plugin": "ziwei",
          style: {
            display: "flex",
            flexDirection: "column",
            height: "100%",
            minHeight: 0,
            width: "100%",
          },
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 14px",
              borderBottom: "1px solid " + COLORS.border,
              flexShrink: 0,
              flexWrap: "wrap",
            },
          },
          h("span", { style: { fontSize: 14, fontWeight: 600 } }, "紫微斗数"),
          // 二级入口：排盘 / 古籍 / 百科（同一个应用的不同路由）
          h(
            "div",
            {
              "data-dsh-ziwei-tabs": "",
              style: {
                display: "flex",
                gap: 2,
                padding: 2,
                borderRadius: 8,
                border: "1px solid " + COLORS.border,
              },
            },
            VIEWS.map(function (item) {
              var active = item.key === view;
              return h(
                "button",
                {
                  key: item.key,
                  type: "button",
                  "data-dsh-ziwei-tab": item.key,
                  "aria-pressed": active,
                  onClick: function () {
                    switchView(item.key);
                  },
                  style: {
                    padding: "3px 10px",
                    borderRadius: 6,
                    border: 0,
                    cursor: active ? "default" : "pointer",
                    font: "inherit",
                    fontSize: 12,
                    background: active ? COLORS.chip : "transparent",
                    color: active ? "inherit" : COLORS.muted,
                  },
                },
                item.label,
              );
            }),
          ),
          h(
            "span",
            { style: { fontSize: 12, color: COLORS.muted } },
            hasChart ? "已读取当前盘面，可直接让 DSH 解读" : "在下方排盘后，可一键交给 DSH 解读",
          ),
          h("span", { style: { flex: 1 } }),
          h("input", {
            type: "text",
            value: question,
            placeholder: "想问什么？（可选）",
            onChange: function (event) {
              setQuestion(event.target.value);
            },
            onKeyDown: function (event) {
              if (event.key === "Enter") askAgent();
            },
            style: {
              width: 240,
              maxWidth: "42vw",
              padding: "5px 10px",
              borderRadius: 7,
              border: "1px solid " + COLORS.border,
              background: COLORS.chip,
              color: "inherit",
              font: "inherit",
              fontSize: 13,
            },
          }),
          h(
            ToolbarButton,
            { primary: true, disabled: !hasChart || !loaded, onClick: askAgent, title: "新开一个 DSH 会话并把盘面交给 Agent" },
            sent ? "已交给 DSH ✓" : "让 DSH 解读",
          ),
          sent
            ? h(
                "span",
                { "data-dsh-ziwei-hint": copied ? "copied" : "session", style: { fontSize: 12, color: COLORS.muted } },
                copied ? "已新开会话；命盘也复制到了剪贴板，粘贴发送即可" : "已新开会话，把命盘粘贴到输入框发送即可",
              )
            : null,
          h(ToolbarButton, { onClick: reload, title: "重新加载排盘页面" }, "刷新"),
          h(
            "a",
            {
              href: homeHref,
              target: "_blank",
              rel: "noreferrer",
              style: { fontSize: 12, color: COLORS.muted, textDecoration: "none" },
            },
            "新窗口打开",
          ),
        ),
        h("iframe", {
          ref: iframeRef,
          src: src,
          title: viewTitle,
          "data-dsh-ziwei-frame": view,
          onLoad: function () {
            setLoaded(true);
            // basePath 重定向偶尔会丢 query，加载完成后再补一次主题同步。
            var frame = iframeRef.current;
            if (frame && frame.contentWindow) {
              frame.contentWindow.postMessage({ type: "dsh-ziwei:theme", theme: hostTheme() }, window.location.origin);
            }
          },
          style: {
            flex: 1,
            minHeight: 0,
            width: "100%",
            border: 0,
            background: "transparent",
          },
        }),
      );
    }

    /**
     * 宠物（dsh-pet）是宿主层的固定浮层，会盖住 iframe 右下角。
     * 量出它在 iframe 坐标里占的高度/宽度，发给排盘页让输入区让开
     * （否则「追问」按钮真实点击会被浮层吞掉）。
     */
    function petInsets(frame) {
      if (!frame || typeof document === 'undefined') return { bottom: 0, right: 0 };
      var pet = document.querySelector('.dsh-pet-figure');
      if (!pet) return { bottom: 0, right: 0 };
      var p = pet.getBoundingClientRect();
      var f = frame.getBoundingClientRect();
      if (p.width === 0 || p.height === 0) return { bottom: 0, right: 0 };
      var overlaps = p.bottom > f.top && p.top < f.bottom && p.right > f.left && p.left < f.right;
      if (!overlaps) return { bottom: 0, right: 0 };
      // 输入区贴着 iframe 底部，约 86px 高；只有当宠物压进这条带子时才需要抬高，
      // 否则只需把输入区从宠物左边缘让开（右边距），底部空间继续留给正文。
      var RESERVED_ROW = 86;
      var rowTop = f.bottom - RESERVED_ROW;
      return {
        bottom: Math.max(0, Math.round(p.bottom - rowTop + 6)),
        right: Math.max(0, Math.round(f.right - p.left + 8)),
      };
    }

    /** 由宿主注入的服务签名：客户端根 context。 */
    var inject = ["slots", "layout"];

    function apply(ctx) {
      var disposers = [];

      /** 取一个可用的 Workspace id：已有工作区就交给宿主按「当前/最近」继承。 */
      function listWorkspaces() {
        try {
          var service = ctx.get ? ctx.get("workspaces", false) : null;
          var source = service && service.list;
          if (!source || typeof source.getSnapshot !== "function") return null;
          var snapshot = source.getSnapshot();
          return snapshot && snapshot.items ? snapshot.items : null;
        } catch (error) {
          return null;
        }
      }

      /**
       * 把盘面交给 Agent：新开会话并预填 prompt，然后切回会话面板。
       * 前沿：已有 Workspace 时 startSession(undefined) 会继承「当前/最近」工作区；
       * 全新 DSH_HOME（一个 Workspace 都没有）会以「Choose a workspace first」失败，
       * 这时先让 host 初始化默认工作区再重试。
       */
      async function askDsh(prompt, workspaceId) {
        try {
          var navigation = ctx.get ? ctx.get("uiWorkspace", false) : null;
          var layout = ctx.get ? ctx.get("layout", false) : null;
          if (!navigation || typeof navigation.startSession !== "function") {
            console.warn("[dsh-ziwei] uiWorkspace 不可用，无法新建会话");
            return false;
          }
          // 必须等 startSession 完成再切面板：提前切走会让这次会话请求被后来的导航取代，
          // 会话虽被创建但不会打开，预填的 prompt 也就丢了。
          await navigation.startSession(workspaceId, { prompt: prompt, whenDraftExists: "append" });
          if (layout && typeof layout.selectPanel === "function") layout.selectPanel(null);
          return true;
        } catch (error) {
          console.warn("[dsh-ziwei] askDsh 失败:", error);
          return false;
        }
      }

      /** 没有 Workspace 时先建默认的，再问一次。 */
      async function ensureWorkspaceThenAsk(prompt) {
        var items = listWorkspaces();
        if (items && items.length > 0) return askDsh(prompt);
        try {
          var service = ctx.get ? ctx.get("workspaces", false) : null;
          if (service && typeof service.initializeDefault === "function") {
            var view = await service.initializeDefault();
            if (view && view.id) return askDsh(prompt, view.id);
          }
        } catch (error) {
          console.warn("[dsh-ziwei] 初始化默认 Workspace 失败:", error);
        }
        return askDsh(prompt);
      }

      try {
        var slots = ctx.slots;
        disposers.push(
          slots.inject("sidebar.panellist", function () {
            return slots.register(
              { name: "sidebar.panellist", id: PANEL_ID, order: PANEL_ORDER, label: function () { return "紫微斗数"; } },
              ZiweiPanelIcon,
            );
          }),
        );
        disposers.push(
          slots.inject("main", function () {
            return slots.register(
              { name: "main", key: PANEL_ID, inject: function () { return { askDsh: ensureWorkspaceThenAsk }; } },
              ZiweiPanelPage,
            );
          }),
        );
      } catch (error) {
        console.warn("[dsh-ziwei] panel registration failed:", error);
      }

      ctx.effect(function () {
        return function () {
          for (var i = 0; i < disposers.length; i += 1) {
            try {
              disposers[i]();
            } catch {}
          }
          disposers.length = 0;
        };
      }, "dsh-ziwei: ui mounts");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

const findAllNodes = (nodes, type) => {
    let found = [];
    for (const node of nodes) {
        if (!type || node.type === type) found.push(node);
        if (node.subgraph && node.subgraph._nodes) {
            found.push(...findAllNodes(node.subgraph._nodes, type));
        } else if (typeof node.getInnerNodes === 'function') {
            try {
                const inner = node.getInnerNodes();
                if (inner) found.push(...findAllNodes(inner, type));
            } catch (e) {}
        }
    }
    return found;
};

function isMobile() {
    const ua = navigator.userAgent;
    // 常规手机
    if (/Android|iPhone|iPod/i.test(ua)) return true;
    // iPadOS 13+ 会伪装成 Mac，但有触摸屏
    if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    return false;
}

const applyBypasser = (v, params, graph) => {
    if (!graph || !graph._nodes) return;
    const nodes = findAllNodes(graph._nodes, null);
    
    const tIds = params.match_id ? (Array.isArray(params.match_id) ? params.match_id : [params.match_id]).map(String) : null;
    const tTitles = params.match_title ? (Array.isArray(params.match_title) ? params.match_title : [params.match_title]).map(String) : null;
    const tGroups = params.match_group ? (Array.isArray(params.match_group) ? params.match_group : [params.match_group]).map(String) : null;
    
    const groupMatchedNodeIds = new Set();
    if (tGroups) {
        const collectFromGraph = (g) => {
            if (!g) return;
            if (g._groups) {
                g._groups.forEach(grp => {
                    if (tGroups.includes(String(grp.title).trim())) {
                        grp.recomputeInsideNodes();
                        if (grp._nodes) grp._nodes.forEach(n => groupMatchedNodeIds.add(String(n.id)));
                    }
                });
            }
            if (g._nodes) g._nodes.forEach(n => { if (n.subgraph) collectFromGraph(n.subgraph) });
        };
        collectFromGraph(graph);
    }
                
    nodes.forEach(n => {
        let match = false;
        const nid = String(n.id);
        const ntitle = String(n.title || n.type);
        if (tIds && tIds.includes(nid)) match = true;
        if (tTitles && tTitles.includes(ntitle)) match = true; // 🔥 补齐：按标题匹配
        if (tGroups && groupMatchedNodeIds.has(nid)) match = true;
        if (match) n.mode = v ? 0 : 4; 
    });
};

const saveWidgetValueToConfig = (node, key, val) => {
    const jsonW = node.widgets?.find(w => w.name === "config_json");
    
    if (jsonW && jsonW.value) {
        try {
            const config = JSON.parse(jsonW.value);
            if (config[key]) {
                config[key].value = val; // 将新值存入对应的 Key 名下
                jsonW.value = JSON.stringify(config);
            }
        } catch(e) { console.error(e); }
    }
};

const notifyConnectedAppBuilder = (bypasserNode) => {
    if (!bypasserNode || !bypasserNode.outputs) return;
    const output = bypasserNode.outputs[0];
    if (output && output.links) {
        output.links.forEach(linkId => {
            const link = app.graph.links[linkId];
            if (link) {
                const targetNode = app.graph.getNodeById(link.target_id);
                if (targetNode && typeof targetNode.syncAllConnections === "function") {
                    targetNode.syncAllConnections(); // 触发主面板刷新
                }
            }
        });
    }
};

const setupUploaderWidget = (node, key, param, defaultVal, validKeys) => {
    // 1. 获取 LoadImage 的图片库列表作为下拉默认值
    let inputFiles = ["None"];
    if (app.node_defs && app.node_defs["LoadImage"]) {
        inputFiles = app.node_defs["LoadImage"].input.required.image[0];
    } else if (defaultVal) {
        inputFiles = [defaultVal];
    }
    
    // 2. 创建或同步 Combo 下拉选择器
    let comboWidget = node.widgets?.find(w => w.name === key);
    if (!comboWidget) {
        comboWidget = node.addWidget("combo", key, defaultVal || inputFiles[0], ()=>{
            if (typeof node.notifyUnpackers === "function") node.notifyUnpackers();
        }, { values: inputFiles });
    } else {
        // 🔥 终极修复：如果它是从存档（加载网页）恢复出来的，它的 options 100% 是 undefined。
        // 我们必须在这里强行帮它初始化 {}，重新赋予它选项列表，否则它将永远失去下拉功能！
        if (!comboWidget.options) comboWidget.options = {}; 
        comboWidget.options.values = inputFiles;
    }
    comboWidget.label = param.name || key;
    
    // 3. 动态维护配套的 "Choose File" 上传按钮
    let uploadBtn = node.widgets?.find(w => w.value === "Upload" && w.associatedKey === key);
    if (!uploadBtn) {
        uploadBtn = node.addWidget("button", "Choose File", "Upload", () => {
            const fileInput = document.createElement("input");
            fileInput.type = "file";
            const mediaType = param.media || 'image';
            if (mediaType === 'image') fileInput.accept = 'image/*';
            else if (mediaType === 'video') fileInput.accept = 'video/*';
            else if (mediaType === 'audio') fileInput.accept = 'audio/*';
            else fileInput.accept = 'image/*,video/*,audio/*';
            
            fileInput.onchange = async () => {
                if (fileInput.files.length > 0) {
                    const file = fileInput.files[0];
                    uploadBtn.label = "Uploading...";
                    node.setDirtyCanvas(true, true);
                    
                    const formData = new FormData();
                    formData.append("image", file);
                    
                    try {
                        const response = await fetch("/upload/image", {
                            method: "POST",
                            body: formData
                        });
                        if (response.ok) {
                            const result = await response.json();
                            
                            if (comboWidget.options && comboWidget.options.values) {
                                if (!comboWidget.options.values.includes(result.name)) {
                                    comboWidget.options.values.push(result.name);
                                }
                            }
                            comboWidget.value = result.name; 
                            uploadBtn.label = "Success ✅";
                            
                            if (comboWidget.callback) comboWidget.callback(result.name);
                            if (typeof node.notifyUnpackers === "function") node.notifyUnpackers();
                        } else {
                            uploadBtn.label = "Failed ❌";
                        }
                    } catch (e) {
                        console.error(e);
                        uploadBtn.label = "Error ❌";
                    }
                    node.setDirtyCanvas(true, true);
                    setTimeout(() => {
                        uploadBtn.label = "Choose File";
                        node.setDirtyCanvas(true, true);
                    }, 1000);
                }
            };
            fileInput.click();
        });
        
        uploadBtn.associatedKey = key; // 🔥 绑定关联主键，用于后续的定位、清理和排序
        uploadBtn.serialize = false;
    }
    
    return comboWidget;
};

// 开启可视化配置浮层
function openConfigOverlay(nodeId) {
    if (document.querySelector('.config-modal-overlay')) return;

    // 创建模糊遮罩层背景
    const overlay = document.createElement('div');
    overlay.className = 'config-modal-overlay';
    overlay.style.cssText = `
        position: fixed;
        top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0, 0, 0, 0.85);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        z-index: 99999;
        display: flex;
        justify-content: center;
        align-items: center;
    `;

    // 载入同级目录下的配置网页 HTML
    const iframe = document.createElement('iframe');
    const htmlUrl = new URL('config_panel.html', import.meta.url);
    htmlUrl.searchParams.set('nodeId', nodeId);
    iframe.src = htmlUrl.href;
    iframe.style.cssText = `
        width: 90vw;
        height: 90vh;
        max-width: 920px;
        max-height: 800px;
        border: 1px solid #333;
        border-radius: 16px;
        background: #121212;
        box-shadow: 0 10px 40px rgba(0,0,0,0.8);
        overflow: hidden;
    `;

    overlay.appendChild(iframe);
    document.body.appendChild(overlay);

    // 注册全局销毁挂载，让 iframe 内部可直接销毁自身
    window.closeConfigOverlay = () => {
        document.body.removeChild(overlay);
        delete window.closeConfigOverlay;
    };
}

app.registerExtension({
    name: "AppBuilder.AppBuilderAdv",
    
    setup() {
        // Expose 实例，保障 AppView 页面及配置浮层能重新抓回
        window.comfyApp = app;
        window.comfyApi = api;
        
        if (!api._queuePromptPatched) {
            api._queuePromptPatched = true;
            const originalQueuePrompt = api.queuePrompt;
            
            api.queuePrompt = async function() {
                try {
                    return await originalQueuePrompt.apply(this, arguments);
                } catch (err) {
                    // 默认使用原有的宽泛错误
                    let detailedMessage = err.message || String(err);
                    
                    // 💡 核心：尝试从 err.response 提取后端的详细 JSON 报错
                    if (err.response) {
                        try {
                            const errorData = err.response.error;
                            const nodeErrors = err.response.node_errors;
                            let details = [];
                            
                            // 1. 获取全局错误类型描述 (例如: "Prompt outputs failed validation")
                            if (errorData && errorData.message) {
                                details.push(errorData.message);
                            }
                            
                            // 2. 遍历后端返回的错误节点对象，提取具体的错误字段
                            if (nodeErrors) {
                                for (const [nodeId, nodeInfo] of Object.entries(nodeErrors)) {
                                    if (nodeInfo.errors && nodeInfo.errors.length > 0) {
                                        nodeInfo.errors.forEach(e => {
                                            // 尝试获取用户自定义的节点名称，如果没有则使用类型或 ID
                                            const nodeDef = app.graph.getNodeById(nodeId);
                                            const nodeTitle = nodeDef?.title || nodeInfo.class_type || `Node ${nodeId}`;
                                            
                                            // 拼接精准报错，例如：[KSampler]: Required input is missing (model)
                                            details.push(`[${nodeTitle}]: ${e.message} (${e.details})`);
                                        });
                                    }
                                }
                            }
                            
                            // 如果成功提取到，则替换 message
                            if (details.length > 0) {
                                detailedMessage = details.join('\n');
                            }
                        } catch (parseErr) {
                            console.warn("Failed to parse ComfyUI detailed error:", parseErr);
                        }
                    }
                    
                    // 广播给活跃的子页面
                    const nodes = [
                        ...app.graph.findNodesByType("AppBuilderAdv"),
                        ...app.graph.findNodesByType("AppBuilder")
                    ];
                    
                    nodes.forEach(node => {
                        if (node.appWindow && !node.appWindow.closed) {
                            node.appWindow.postMessage({
                                type: 'pre_queue_error',
                                message: detailedMessage
                            }, '*');
                        }
                    });
                    
                    throw err; // 👈 扔回给 ComfyApp 原生核心
                }
            };
        }
        
        const originalGraphToPrompt = app.graphToPrompt;
        
        app.graphToPrompt = async function () {
            const res = await originalGraphToPrompt.apply(this, arguments);
            const prompt = res.output; 
            
            try {
                const panelOutputs = {};
                const replaceMap = {};
                
                for (const [nodeId, node] of Object.entries(prompt)) {
                    if (node.class_type === "AppBuilderAdv") {
                        const configJson = node.inputs?.config_json || "{}";
                        let config = {};
                        try { config = JSON.parse(configJson); } catch(e) {}
                        
                        const entries = Object.entries(config).slice(0, 32).filter(([k, p]) => {
                            const t = (p.type || "STRING").toUpperCase();
                            return t !== "BUTTON" && t !== "BYPASSER";
                        });
                        
                        panelOutputs[nodeId] = {};
                        entries.forEach(([key, params], slotIdx) => {
                            const type = (params.type || "STRING").toUpperCase();
                            if (type === "INPUT") {
                                const rawOpt = params.optional || false;
                                const displayKey = rawOpt ? `${key} (opt)` : key;
                                const inLink = node.inputs[displayKey];
                                
                                if (inLink && Array.isArray(inLink)) {
                                    panelOutputs[nodeId][slotIdx] = inLink;
                                } else {
                                    if (rawOpt) {
                                        panelOutputs[nodeId][slotIdx] = null;
                                    } else {
                                        alert(`Validation Error: Required input '${key}' is missing!`);
                                        throw new Error(`Required input missing`);
                                    }
                                }
                            } else {
                                let val = node.inputs[key];
                                if (val === undefined) val = params.default;
                                if (type === "INT" || type === "SEED") val = Math.round(Number(val));
                                else if (type === "FLOAT") val = Number(val);
                                else if (type === "BOOLEAN" || type === "BYPASSER") val = Boolean(val);
                                else if (type === "STRING" || type === "UPLOADER") val = String(val);
                                panelOutputs[nodeId][slotIdx] = val;
                            }
                        });
                    }
                }
                            
                for (const [nodeId, node] of Object.entries(prompt)) {
                    if (node.class_type === "ParametersUnpacker") {
                        let panelId = null;
                        if (node.inputs) {
                            for (const val of Object.values(node.inputs)) {
                                if (Array.isArray(val) && val.length === 2) {
                                    panelId = String(val[0]);
                                    break;
                                }
                            }
                        }
                        if (panelId && panelOutputs[panelId]) {
                            replaceMap[nodeId] = panelOutputs[panelId];
                        }
                    }
                }
                            
                for (const [nodeId, node] of Object.entries(prompt)) {
                    if (node.class_type === "AppBuilderAdv" || node.class_type === "ParametersUnpacker") continue;
                    
                    if (node.inputs) {
                        for (const [inKey, inVal] of Object.entries(node.inputs)) {
                            if (Array.isArray(inVal) && inVal.length === 2) {
                                const sourceId = String(inVal[0]);
                                const sourceSlot = inVal[1];
                                
                                if (replaceMap[sourceId] && replaceMap[sourceId][sourceSlot] !== undefined) {
                                    const replaceVal = replaceMap[sourceId][sourceSlot];
                                    if (replaceVal === null) {
                                        delete node.inputs[inKey];
                                    } else {
                                        node.inputs[inKey] = replaceVal;
                                    }
                                }
                            }
                        }
                    }
                }
                    
                for (const nodeId of Object.keys(prompt)) {
                    if (prompt[nodeId].class_type === "AppBuilderAdv" || prompt[nodeId].class_type === "ParametersUnpacker") {
                        delete prompt[nodeId];
                    }
                }
            } catch(e) {
                console.error("[AppBuilder] Graph interception failed:", e);
            }
            return res; 
        };
    },
    
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AppBuilderAdv") {
            
            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info) {
                this.isConfigured = true; 
                if (onConfigure) onConfigure.apply(this, arguments);
                
                if (info && info.widgets_values) {
                    const savedJson = info.widgets_values[0];
                    this.buildDynamicUI(savedJson, true, info.widgets_values); 
                }
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                
                this.size = [300, 120]; // 👈 参数区现在极其紧凑，不再冗长

                // 注册跨窗口和刷新事件
                this.registerAppWindow = (appWin) => {
                    this.appWindow = appWin;
                    
                    const onPreview = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'b_preview', blob: e.detail }, '*');
                        }
                    };
                    const onExecuted = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'executed', detail: e.detail }, '*');
                        }
                    };
                    const onStart = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'execution_start' }, '*');
                        }
                    };
                    const onStatus = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'status', detail: e.detail }, '*');
                        }
                    };
                    const onInterrupted = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'execution_interrupted' }, '*');
                        }
                    };
                    const onProgress = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'progress', detail: e.detail }, '*');
                        }
                    };
                    const onExecutionError = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'execution_error', detail: e.detail }, '*');
                        }
                    };
                    const onExecuting = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'executing', detail: e.detail }, '*');
                        }
                    };
                    const onLog = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'log', detail: e.detail }, '*');
                        }
                    };

                    if (this._onPreview) {
                        api.removeEventListener("b_preview", this._onPreview);
                        api.removeEventListener("executed", this._onExecuted);
                        api.removeEventListener("execution_start", this._onStart);
                        api.removeEventListener("status", this._onStatus);
                        api.removeEventListener("execution_interrupted", this._onInterrupted);
                        api.removeEventListener("progress", this._onProgress);
                        api.removeEventListener("execution_error", this._onExecutionError);
                        api.removeEventListener("executing", this._onExecuting);
                    }

                    this._onPreview = onPreview;
                    this._onExecuted = onExecuted;
                    this._onStart = onStart;
                    this._onStatus = onStatus;
                    this._onInterrupted = onInterrupted;
                    this._onProgress = onProgress;
                    this._onExecutionError = onExecutionError;
                    this._onExecuting = onExecuting;

                    api.addEventListener("b_preview", onPreview);
                    api.addEventListener("executed", onExecuted);
                    api.addEventListener("execution_start", onStart);
                    api.addEventListener("status", onStatus);
                    api.addEventListener("execution_interrupted", onInterrupted);
                    api.addEventListener("progress", onProgress);
                    api.addEventListener("execution_error", onExecutionError);
                    api.addEventListener("executing", onExecuting);
                };

                const onRemoved = this.onRemoved;
                this.onRemoved = () => {
                    if (this._onPreview) {
                        api.removeEventListener("b_preview", this._onPreview);
                        api.removeEventListener("executed", this._onExecuted);
                        api.removeEventListener("execution_start", this._onStart);
                        api.removeEventListener("status", this._onStatus);
                        api.removeEventListener("execution_interrupted", this._onInterrupted);
                        api.removeEventListener("progress", this._onProgress);
                        api.removeEventListener("execution_error", this._onExecutionError);
                        api.removeEventListener("executing", this._onExecuting);
                    }
                    if (onRemoved) onRemoved.apply(this, arguments);
                };

                // 👇【核心修改：只添加一个配置按钮，完全删除旧的 Lock / Update 等繁琐组件】
                this.addWidget("button", "⚙️ Configure Panel", "btn_configure", () => {
                    openConfigOverlay(this.id);
                });

                const btnWidget = this.addWidget("button", "📱 Open in AppView", "btn_app_view", () => {
                    const htmlUrl = new URL('app_view.html', import.meta.url);
                    htmlUrl.searchParams.set('nodeId', this.id); 
                    
                    if (isMobile()) {
                        let oldIframe = document.getElementById("appview-iframe");
                        if (oldIframe) {
                            oldIframe.remove(); 
                        }
                        
                        // 每次都凭空捏造一个绝对干净的新容器
                        let iframe = document.createElement("iframe");
                        iframe.id = "appview-iframe";
                        iframe.style.position = "fixed";
                        iframe.style.top = "0";
                        iframe.style.left = "0";
                        iframe.style.bottom = "0";
                        iframe.style.width = "100%";
                        iframe.style.height = "100dvh";
                        iframe.style.zIndex = "999999";
                        iframe.style.border = "none";
                        
                        // 👇【绝对核心 2】：在加载网页前，先把容器底色刷成纯黑！杜绝加载网络时的白屏闪烁
                        const savedTheme = localStorage.getItem('appview_theme') || 'dark';
                        iframe.style.backgroundColor = savedTheme === 'light' ? '#fafafa' : '#000000';
                        
                        document.body.appendChild(iframe);
                        iframe.src = htmlUrl.href;
                        
                        this.registerAppWindow(iframe.contentWindow);
                    } else {
                        // 💻 电脑端：保持原样，打开独立新标签页
                        const appWindow = window.open(htmlUrl.href, '_blank');
                        if (!appWindow) {
                            alert("Please allow pop-ups for this site to open the AppView.");
                            return;
                        }
                        this.registerAppWindow(appWindow);
                    }
                });
                
                // 👇 【核心修复】：利用 Object.defineProperty 绕过只读 Getter 限制，强行重写绘制高度
                Object.defineProperty(btnWidget, 'height', {
                    get() { return 40; }, // 👈 在这里返回你想要的视觉高度（例如 40）
                    configurable: true    // 允许属性可配置
                });
                
                // 保持原有的判定区大小与之同步
                btnWidget.computeSize = function(width) {
                    return [width, 40]; 
                };
                
                this.hideWidget = function(widget) {
                    if (!widget._origType) widget._origType = widget.type;
                    widget.hidden = true;
                    widget.type = "converted-widget";
                    widget.computeSize = () => [0, -4];
                }
                
                this.showWidget = function(widget) {
                    widget.hidden = false;
                    widget.computeSize = undefined;
                    if (widget._origType) widget.type = widget._origType;
                }

                // 强制将画布上的无用配置字段（config_json等）永久隐藏
                setTimeout(() => {
                    const jsonW = this.widgets.find(w => w.name === "config_json");
                    if (jsonW) this.hideWidget(jsonW);
                    const prevW = this.widgets.find(w => w.name === "live_preview");
                    if (prevW) this.hideWidget(prevW);
                    this.computeSize();
                    this.setDirtyCanvas(true, true);
                }, 50);

                this.notifyUnpackers = function() {
                    if (!this.outputs || !this.outputs[0].links) return;
                    this.outputs[0].links.forEach(linkId => {
                        const link = app.graph.links[linkId];
                        if (link) {
                            const targetNode = app.graph.getNodeById(link.target_id);
                            if (targetNode && targetNode.type === "ParametersUnpacker") {
                                targetNode.syncFromUpstream();
                            }
                        }
                    });
                };

                this.buildDynamicUI = async function(customJsonStr = null, isRestoring = false, storedValues = null) {
                    this.imgs = [];
                    this.setDirtyCanvas(true, true);
                    
                    let jsonStr = customJsonStr || this.widgets.find(w => w.name === "config_json")?.value;
                    if (jsonStr === "" || !jsonStr) jsonStr = "{}";

                    let config;
                    try { config = JSON.parse(jsonStr); } catch (e) { return; }
                    
                    const entries = Object.entries(config).slice(0, 32);

                    const isStatic = (w) => (
                        w.name === "config_json" || 
                        w.name === "live_preview" || 
                        w.value === "btn_configure" || 
                        w.value === "btn_app_view"
                    );

                    for (let i = this.widgets.length - 1; i >= 0; i--) {
                        if (!isStatic(this.widgets[i])) {
                            if (this.widgets[i].onRemove) this.widgets[i].onRemove();
                            this.widgets.splice(i, 1);
                        }
                    }
                    
                    if (this.inputs) while(this.inputs.length > 0) this.removeInput(this.inputs.length - 1);

                    const oldInputs = [];
                    if (this.inputs) {
                        for (let i = 0; i < this.inputs.length; i++) {
                            const inp = this.inputs[i];
                            if (inp.link) {
                                const l = app.graph.links[inp.link];
                                if (l) {
                                    oldInputs.push({ name: inp.name, origin_id: l.origin_id, origin_slot: l.origin_slot });
                                }
                            }
                        }
                        while(this.inputs.length > 0) {
                            this.removeInput(this.inputs.length - 1);
                        }
                    }

                    for (const [key, params] of entries) {
                        const type = (params.type || "STRING").toUpperCase();
                        let widget;
                        let val = params.default;

                        if (type === "INT" || type === "FLOAT") {
                            const isInt = type === "INT";
                            const step = params.step ?? (isInt ? 1 : 0.1);
                            const prec = params.precision ?? (isInt ? 0 : 3);
                            const isSlider = params.slider === true || params.display === "slider";
                            
                            if (isSlider && (params.min === undefined || params.max === undefined)) {
                                continue;
                            }
                            
                            const minVal = params.min ?? -999999;
                            const maxVal = params.max ?? 999999;
                            const initVal = val ?? 0;
                            
                            widget = this.addWidget(isSlider ? "slider" : "number", key, initVal, (v) => {
                                let snapped = isInt ? Math.round(v) : Math.round(v / step) * step;
                                const finalVal = parseFloat(snapped.toFixed(prec));
                                if (widget.value !== finalVal) {
                                    widget.value = finalVal;
                                }
                            }, { 
                                min: minVal, 
                                max: maxVal, 
                                step: isSlider ? step : step * 10, 
                                precision: prec 
                            });
                        } else if (type === "SEED") {
                            const minVal = params.min ?? 0;
                            const maxVal = params.max ?? 0xffffffffffffffff;
                            const initVal = val ?? params.default ?? 0;
                                
                            ComfyWidgets.INT(this, key, ["INT", { 
                                default: initVal, 
                                min: minVal, 
                                max: maxVal, 
                                control_after_generate: true 
                            }], app);
                            
                            widget = this.widgets.find(w => w.name === key);
                            if (widget) widget.value = initVal;
                        } else if (type === "STRING") {
                            if (params.multiline || params.placeholder) {
                                ComfyWidgets.STRING(this, key, ["STRING", { multiline: !!params.multiline, default: val || "" }], app);
                                widget = this.widgets[this.widgets.length - 1];
                                widget.value = val || "";
                                if (widget.inputEl && params.placeholder) widget.inputEl.placeholder = params.placeholder;
                            } else {
                                widget = this.addWidget("text", key, val || "", (v) => {}, {});
                            }
                        } else if (type === "COMBO") {
                            let values = params.values || ["None"];
                            if (params.folder) {
                                try {
                                    const response = await fetch(`/appbuilder/ls/${params.folder}`);
                                    if (response.ok) {
                                        const data = await response.json();
                                        values = ["None", ...data];
                                    }
                                } catch (e) { console.error("Fetch models failed:", e); }
                            }
                            widget = this.addWidget("combo", key, val || values[0], (v) => {}, { values: values });
                        } else if (type === "BOOLEAN") {
                            widget = this.addWidget("toggle", key, val ?? true, (v) => {}, {});
                        } else if (type === "BYPASSER") {
                            const applyMuter = (v) => {
                                const nodes = findAllNodes(app.graph._nodes, null); 
                                const tIds = params.match_id ? (Array.isArray(params.match_id) ? params.match_id : [params.match_id]).map(String) : null;
                                const tTitles = params.match_title ? (Array.isArray(params.match_title) ? params.match_title : [params.match_title]).map(String) : null;
                                const tGroups = params.match_group ? (Array.isArray(params.match_group) ? params.match_group : [params.match_group]).map(String) : null;
                                
                                const groupMatchedNodeIds = new Set();
                                if (tGroups) {
                                    const collectFromGraph = (graph) => {
                                        if (!graph) return;
                                        if (graph._groups) {
                                            graph._groups.forEach(g => {
                                                if (tGroups.includes(String(g.title).trim())) {
                                                    g.recomputeInsideNodes();
                                                    if (g._nodes) g._nodes.forEach(n => groupMatchedNodeIds.add(String(n.id)));
                                                }
                                            });
                                        }
                                        if (graph._nodes) graph._nodes.forEach(n => { if (n.subgraph) collectFromGraph(n.subgraph) });
                                    };
                                    collectFromGraph(app.graph);
                                }
                                
                                nodes.forEach(n => {
                                    let match = false;
                                    const nid = String(n.id);
                                    const ntitle = String(n.title || n.type);
                                    if (tIds) match = tIds.includes(nid);
                                    if (tTitles) match = tTitles.includes(ntitle);
                                    if (tGroups) match = groupMatchedNodeIds.has(nid);
                                    if (match) n.mode = v ? 0 : 4;
                                });
                            };
                            widget = this.addWidget("toggle", key, val, (v) => applyMuter(v), {});
                            setTimeout(() => applyMuter(widget.value), 300);
                        } else if (type === "UPLOADER") {
                            const oldValidKeys = entries.map(([k, p]) => k);
                            widget = setupUploaderWidget(this, key, params, val, oldValidKeys);
                        }  else if (type === "INPUT") {
                            const inputClass = params.class ? String(params.class).toUpperCase() : "*";
                            const isOptional = params.optional ?? false;
                            this.addInput(key, inputClass, {shape: isOptional ? 7 : undefined});
                            
                            const newIdx = this.inputs.length - 1;
                            const backup = oldInputs.find(l => l.name === key);
                            if (backup) {
                                const originNode = app.graph.getNodeById(backup.origin_id);
                                if (originNode) originNode.connect(backup.origin_slot, this, newIdx);
                            }
                        }

                        if (widget) {
                            widget.label = params.name || key;
                            widget.tooltip = params.tooltip;
                            
                            if (storedValues) {
                                const wIdx = this.widgets.indexOf(widget);
                                if (wIdx !== -1 && storedValues[wIdx] !== undefined) widget.value = storedValues[wIdx];
                            }
                        }
                    }
                    
                    if (!isRestoring) this.notifyUnpackers();
                    this.computeSize();
                    this.setDirtyCanvas(true, true);
                };

                setTimeout(() => {
                    const jsonW = this.widgets.find(w => w.name === "config_json");
                    if (jsonW) this.hideWidget(jsonW);
                    const prevW = this.widgets.find(w => w.name === "live_preview");
                    if (prevW) this.hideWidget(prevW);
                    if (!this.isConfigured) this.buildDynamicUI(null, true);
                }, 100);
                return r;
            };
        }
        
        if (nodeData.name === "ParametersUnpacker") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                this.outputs = [];
                this.size = [200, 40];
                
                this.syncFromUpstream = function() {
                    if (!this.inputs || !this.inputs[0].link) {
                        if (this.outputs) {
                            for (let i = 0; i < this.outputs.length; i++) this.disconnectOutput(i);
                        }
                        this.outputs = [];
                        this.computeSize();
                        this.setDirtyCanvas(true, true);
                        return;
                    }
                    
                    const linkId = this.inputs[0].link;
                    const link = app.graph.links[linkId];
                    if (!link) return;
                    
                    const upstreamNode = app.graph.getNodeById(link.origin_id);
                    if (!upstreamNode || upstreamNode.type !== "AppBuilderAdv") return;
                    
                    const jsonWidget = upstreamNode.widgets.find(w => w.name === "config_json");
                    if (!jsonWidget) return;
                    const value = jsonWidget.value || "{}"
                    
                    let config;
                    try { config = JSON.parse(value); } catch (e) { return; }
                    const entries = Object.entries(config).slice(0, 32);
                    
                    const outputEntries = entries.filter(([k, p]) => {
                        const t = (p.type || "STRING").toUpperCase();
                        return t !== "BUTTON" && t !== "BYPASSER";
                    });
                    
                    const oldLinks = [];
                    if (this.outputs) {
                        for (let i = 0; i < this.outputs.length; i++) {
                            const output = this.outputs[i];
                            if (output.links && output.links.length > 0) {
                                const linksInfo = output.links.map(lId => {
                                    const l = app.graph.links[lId];
                                    return l ? { target_id: l.target_id, target_slot: l.target_slot } : null;
                                }).filter(l => l);
                                oldLinks.push({ name: output.name, connections: linksInfo });
                                this.disconnectOutput(i);
                            }
                        }
                    }
                    
                    this.outputs = [];
                    outputEntries.forEach(([key, params], idx) => {
                        const baseType = (params.type || "*").toUpperCase();
                        let outputClass;
                        
                        if (params.class) {
                            outputClass = String(params.class).toUpperCase()
                        } else if (baseType === "INPUT") {
                            outputClass = "*"; 
                        } else if (baseType === "SEED") {
                            outputClass = "INT"; 
                        } else if (baseType === "UPLOADER") {
                            outputClass = "COMBO"; 
                        } else {
                            outputClass = baseType; 
                        }
                        
                        const displayName = params.name || key;
                        const isOptional = params.optional ?? false;
                        
                        this.addOutput(key, outputClass, {shape: isOptional ? 7 : undefined});
                        const newOutput = this.outputs[this.outputs.length - 1];
                        newOutput.label = displayName;
                        
                        const backup = oldLinks.find(l => l.name === key);
                        if (backup) {
                            backup.connections.forEach(conn => {
                                this.connect(idx, conn.target_id, conn.target_slot);
                            });
                        }
                    });
                    
                    this.setSize(this.computeSize());
                    this.setDirtyCanvas(true, true);
                };
                
                return r;
            };
            
            const onConnectionsChange = nodeType.prototype.onConnectionsChange;
            nodeType.prototype.onConnectionsChange = function (type, slotIndex, isConnected, linkInfo) {
                if (onConnectionsChange) onConnectionsChange.apply(this, arguments);
                
                if (type === 1 && slotIndex === 0) {
                    setTimeout(() => this.syncFromUpstream(), 50);
                }
            };
            
            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                if (onConfigure) onConfigure.apply(this, arguments);
                setTimeout(() => this.syncFromUpstream(), 100);
            };
        }
    }
});


app.registerExtension({
    name: "AppBuilder.AppBuilder",
    
    setup() {
        window.comfyApp = app;
        window.comfyApi = api;
        
        const originalGraphToPrompt = app.graphToPrompt;
        app.graphToPrompt = async function () {
            const res = await originalGraphToPrompt.apply(this, arguments);
            const prompt = res.output; 
            try {
                const builderNodes = app.graph.findNodesByType("AppBuilder");
                const panelData = {};
                builderNodes.forEach(node => {
                    const nodeId = String(node.id);
                    panelData[nodeId] = {};
                    let config = {};
                    const jsonW = node.widgets?.find(w => w.name === "config_json");
                    if (jsonW && jsonW.value) {
                        try { config = JSON.parse(jsonW.value); } catch(e) {}
                    }
                    Object.entries(config).forEach(([key, param]) => {
                        const slotIdx = param._slot;
                        if (slotIdx === undefined) return;
                        const targetWidget = node.widgets?.find(w => w.name === key);
                        let val = targetWidget ? targetWidget.value : param.default;
                        if (param.type === "INT" || param.type === "SEED") val = Math.round(Number(val));
                        else if (param.type === "FLOAT") val = Number(val);
                        panelData[nodeId][slotIdx] = val;
                    });
                });

                for (const [nodeId, promptNode] of Object.entries(prompt)) {
                    if (promptNode.class_type === "AppBuilder") continue;
                    if (promptNode.inputs) {
                        for (const [inKey, inVal] of Object.entries(promptNode.inputs)) {
                            if (Array.isArray(inVal) && inVal.length === 2) {
                                const sourceId = String(inVal[0]);
                                const sourceSlot = inVal[1];
                                if (panelData[sourceId] !== undefined) {
                                    const valToInject = panelData[sourceId][sourceSlot];
                                    if (valToInject !== undefined) promptNode.inputs[inKey] = valToInject;
                                    else delete promptNode.inputs[inKey];
                                }
                            }
                        }
                    }
                }
                    
                for (const nodeId of Object.keys(prompt)) {
                    if (["AppBuilder", "AppBuilderBypasser"].includes(prompt[nodeId].class_type)) {
                        delete prompt[nodeId];
                    }
                }
            } catch(e) { console.error(e); }
            return res; 
        };
    },

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        
        // ==========================================
        // 节点 A：收集器节点 (AppBuilderBypasser)
        // ==========================================
        if (nodeData.name === "AppBuilderBypasser") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                this.addInput("node_1", "*"); 
                //this.addOutput("BYPASSER", "BYPASSER");
                this.size = [220, 80];

                // 🔥 当输入框文本发生改变时，通知主节点重新拉取配置
                setTimeout(() => {
                    // 绑定组名修改回调
                    const groupWidget = this.widgets?.find(w => w.name === "group_name");
                    if (groupWidget) {
                        groupWidget.callback = () => notifyConnectedAppBuilder(this);
                    }
                    
                    // 🔥 新增：绑定名称修改回调，实现输入文字时主面板实时改名！
                    const nameWidget = this.widgets?.find(w => w.name === "bypasser_name");
                    if (nameWidget) {
                        nameWidget.callback = () => notifyConnectedAppBuilder(this);
                    }
                }, 100);

                return r;
            };

            const onConnectionsChange = nodeType.prototype.onConnectionsChange;
            nodeType.prototype.onConnectionsChange = function (type, slotIndex, isConnected, linkInfo) {
                if (onConnectionsChange) onConnectionsChange.apply(this, arguments);
                if (type === 1) { // 输入端变化（挂接目标节点）
                    let hasEmpty = false;
                    for (let i = this.inputs.length - 1; i >= 0; i--) {
                        if (this.inputs[i].name.startsWith("node_")) {
                            if (!this.inputs[i].link) {
                                if (hasEmpty) this.removeInput(i);
                                else hasEmpty = true;
                            }
                        }
                    }
                    if (!hasEmpty) this.addInput(`node_${this.inputs.length + 1}`, "*");
                    this.setSize(this.computeSize());
                }
                setTimeout(() => { notifyConnectedAppBuilder(this); }, 100);
            };
            nodeType.prototype.onWidgetChanged = function (name) {
                if (name === "group_name" || name === "bypasser_name") notifyConnectedAppBuilder(this);
            };
        }

        // ==========================================
        // 节点 B：主控制节点 (AppBuilder)
        // ==========================================
        if (nodeData.name === "AppBuilder") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                this.size = [300, 100];
                
                // 🔥 找回递增序号：初始化首个递增 Bypasser 接口
                this.addInput("bypasser_1", "BYPASSER", { shape: 7 }); 
                
                this.hideWidget = (widget) => {
                    widget.hidden = true;
                    widget.type = "converted-widget";
                    widget.computeSize = () => [0, -4];
                };

                this.registerAppWindow = (appWin) => {
                    this.appWindow = appWin;
                    
                    const onPreview = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'b_preview', blob: e.detail }, '*');
                        }
                    };
                    const onExecuted = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'executed', detail: e.detail }, '*');
                        }
                    };
                    const onStart = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'execution_start' }, '*');
                        }
                    };
                    const onStatus = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'status', detail: e.detail }, '*');
                        }
                    };
                    const onInterrupted = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'execution_interrupted' }, '*');
                        }
                    };
                    const onProgress = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'progress', detail: e.detail }, '*');
                        }
                    };
                    const onExecutionError = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'execution_error', detail: e.detail }, '*');
                        }
                    };
                    const onExecuting = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'executing', detail: e.detail }, '*');
                        }
                    };
                    const onLog = (e) => {
                        if (this.appWindow && !this.appWindow.closed) {
                            this.appWindow.postMessage({ type: 'log', detail: e.detail }, '*');
                        }
                    };
                    
                    if (this._onPreview) {
                        api.removeEventListener("b_preview", this._onPreview);
                        api.removeEventListener("executed", this._onExecuted);
                        api.removeEventListener("execution_start", this._onStart);
                        api.removeEventListener("status", this._onStatus);
                        api.removeEventListener("execution_interrupted", this._onInterrupted);
                        api.removeEventListener("progress", this._onProgress);
                        api.removeEventListener("execution_error", this._onExecutionError);
                        api.removeEventListener("executing", this._onExecuting);
                    }
                    
                    this._onPreview = onPreview;
                    this._onExecuted = onExecuted;
                    this._onStart = onStart;
                    this._onStatus = onStatus;
                    this._onInterrupted = onInterrupted;
                    this._onProgress = onProgress;
                    this._onExecutionError = onExecutionError;
                    this._onExecuting = onExecuting;
                    
                    api.addEventListener("b_preview", onPreview);
                    api.addEventListener("executed", onExecuted);
                    api.addEventListener("execution_start", onStart);
                    api.addEventListener("status", onStatus);
                    api.addEventListener("execution_interrupted", onInterrupted);
                    api.addEventListener("progress", onProgress);
                    api.addEventListener("execution_error", onExecutionError);
                    api.addEventListener("executing", onExecuting);
                };
                
                const onRemoved = this.onRemoved;
                this.onRemoved = () => {
                    if (this._onPreview) {
                        api.removeEventListener("b_preview", this._onPreview);
                        api.removeEventListener("executed", this._onExecuted);
                        api.removeEventListener("execution_start", this._onStart);
                        api.removeEventListener("status", this._onStatus);
                        api.removeEventListener("execution_interrupted", this._onInterrupted);
                        api.removeEventListener("progress", this._onProgress);
                        api.removeEventListener("execution_error", this._onExecutionError);
                        api.removeEventListener("executing", this._onExecuting);
                    }
                    if (onRemoved) onRemoved.apply(this, arguments);
                };
                
                setTimeout(() => {
                    const jsonW = this.widgets?.find(w => w.name === "config_json");
                    if (jsonW) {
                        this.hideWidget(jsonW);
                        this.computeSize();
                        this.setDirtyCanvas(true, true);
                    }
                }, 50);

                const btnWidget = this.addWidget("button", "📱 Open in AppView", "btn_app_view", () => {
                    this.syncAllConnections(); // 打开前强制同步一次

                    const htmlUrl = new URL('app_view.html', import.meta.url);
                    htmlUrl.searchParams.set('nodeId', this.id); 
                    
                    if (isMobile()) {
                        let oldIframe = document.getElementById("appview-iframe");
                        if (oldIframe) {
                            oldIframe.remove(); 
                        }
                        
                        let iframe = document.createElement("iframe");
                        iframe.id = "appview-iframe";
                        iframe.style.position = "fixed";
                        iframe.style.top = "0";
                        iframe.style.left = "0";
                        iframe.style.bottom = "0";
                        iframe.style.width = "100%";
                        iframe.style.height = "100dvh";
                        iframe.style.zIndex = "999999";
                        iframe.style.border = "none";
                        
                        const savedTheme = localStorage.getItem('appview_theme') || 'dark';
                        iframe.style.backgroundColor = savedTheme === 'light' ? '#fafafa' : '#000000';
                        
                        document.body.appendChild(iframe);
                        iframe.src = htmlUrl.href;
                        
                        this.registerAppWindow(iframe.contentWindow);
                    } else {
                        const appWindow = window.open(htmlUrl.href, '_blank');
                        if (!appWindow) {
                            alert("Please allow pop-ups for this site to open the AppView.");
                            return;
                        }
                        this.registerAppWindow(appWindow);
                    }
                });
                Object.defineProperty(btnWidget, 'height', { get() { return 40; }, configurable: true });
                btnWidget.computeSize = function(width) { return [width, 40]; };
                // 在 onNodeCreated 接近末尾 return r; 之前：
                if (this.inputs) {
                    for (let i = this.inputs.length - 1; i >= 0; i--) {
                        if (this.inputs[i].name === "config_json") {
                            this.removeInput(i); // 🔥 物理拔除
                        }
                    }
                }
                return r;
            };

            // 🔥 核心修改：左右双向自动扩展
            const onConnectionsChange = nodeType.prototype.onConnectionsChange;
            nodeType.prototype.onConnectionsChange = function (type, slotIndex, isConnected, linkInfo) {
                if (onConnectionsChange) onConnectionsChange.apply(this, arguments);
                
                if (type === 1) { // 左侧输入 (Bypasser)
                    let hasEmpty = false;
                    for (let i = this.inputs.length - 1; i >= 0; i--) {
                        if (this.inputs[i].name.startsWith("bypasser_")) {
                            if (!this.inputs[i].link) { 
                                if (hasEmpty) this.removeInput(i); 
                                else hasEmpty = true; 
                            }
                        }
                    }
                    // 🔥 找回递增序号：根据现有通道计算出下一个合理的编号并加上 `bypasser_` 前缀
                    if (!hasEmpty) {
                        let nextIdx = 1;
                        while(this.inputs.find(inp => inp.name === `bypasser_${nextIdx}`)) nextIdx++;
                        this.addInput(`bypasser_${nextIdx}`, "BYPASSER", { shape: 7 });
                    }
                }
                setTimeout(() => this.syncAllConnections(), 50);
            };

            // 🔥 核心修改：整合左右连线信息，生成 JSON
            nodeType.prototype.syncAllConnections = function() {
                if (this.inputs) {
                    for (let i = this.inputs.length - 1; i >= 0; i--) {
                        if (this.inputs[i].name === "config_json") {
                            this.removeInput(i);
                        }
                    }
                }
                
                const jsonW = this.widgets?.find(w => w.name === "config_json");
                let oldConfig = {};
                if (jsonW && jsonW.value) {
                    try {
                        oldConfig = JSON.parse(jsonW.value);
                    } catch(e) { console.error(e); }
                }
                
                let hasEmptyOutput = false;
                for (let i = this.outputs.length - 1; i >= 0; i--) {
                    const output = this.outputs[i];
                    // 此时断线已彻底完成，这里的 links 判断 100% 精准
                    if (!output.links || output.links.length === 0) {
                        if (hasEmptyOutput) {
                            this.removeOutput(i); // 如果已经保留过一个空插槽了，删掉其余多余的
                        } else {
                            hasEmptyOutput = true; // 标记我们已经留好了一个空闲插槽用于下次连线
                        }
                    }
                }
                
                // 如果全连满了，自动在末尾补一个
                if (!hasEmptyOutput) this.addOutput(`any`, "*");
                // 重新校准剩下所有插槽的名字，统一规范化为 "any"
                this.outputs.forEach((output, idx) => { output.name = "any"; });
                
                let config = {};
                let validKeys = [];

                // 1. 扫描右侧输出
                this.outputs.forEach((output, outIdx) => {
                    if (output.name !== "any" || !output.links || output.links.length === 0) return; 
                    const link = app.graph.links[output.links[0]];
                    if (!link) return;
                    const targetNode = app.graph.getNodeById(link.target_id);
                    if (!targetNode || !targetNode.inputs) return;
                    
                    const targetSlot = targetNode.inputs[link.target_slot];
                    const targetSlotName = targetSlot.name;
                    
                    let pType = "STRING"; 
                    let pOpts = {}; 
                    let pValues = undefined;
                    
                    // 终极通道 A
                    const nodeDefs = app.nodeDefs || app.node_defs || (app.extensionManager ? app.extensionManager.nodeDefs : null);
                    const nodeDef = (nodeDefs ? nodeDefs[targetNode.type] : null) || targetNode.constructor?.nodeData;
                    
                    if (nodeDef && nodeDef.input) {
                        let paramDef = nodeDef.input.required?.[targetSlotName] || nodeDef.input.optional?.[targetSlotName];
                        if (paramDef) {
                            const typeInfo = paramDef[0];
                            pOpts = paramDef[1] || {};
                            
                            const optionsList = pOpts.options || pOpts.values;
                            
                            if (Array.isArray(typeInfo)) { 
                                pType = "COMBO"; 
                                pValues = typeInfo; 
                            } else if (typeInfo === "COMBO" || (pOpts && Array.isArray(optionsList))) {
                                pType = "COMBO";
                                pValues = optionsList; 
                            }
                            else if (typeInfo === "INT") pType = "INT";
                            else if (typeInfo === "FLOAT") pType = "FLOAT";
                            else if (typeInfo === "BOOLEAN") pType = "BOOLEAN";
                            else if (typeInfo === "STRING") pType = "STRING";
                            else {
                                pType = String(typeInfo).toUpperCase();
                            }
                        }
                    }
                    
                    // 备份通道 B
                    if (pType === "STRING" && pValues === undefined) {
                        const slotWidget = targetSlot ? targetSlot.widget : null;
                        const liveWidget = slotWidget || targetNode.widgets?.find(w => w.name === targetSlotName);
                        if (liveWidget && liveWidget.type !== "converted-widget" && liveWidget.type !== "CONVERTED-WIDGET") {
                            const wType = String(liveWidget._origType || liveWidget.type || "").toUpperCase();
                            const widgetOptions = liveWidget.options || {};
                            const liveOptionsList = widgetOptions.options || widgetOptions.values;
                            
                            if (wType === "COMBO" || Array.isArray(liveOptionsList)) {
                                pType = "COMBO";
                                pValues = liveOptionsList;
                            }
                        }
                    }
                    
                    const tTitle = String(targetNode.title || targetNode.type).toLowerCase();
                    const tSlot = String(targetSlotName).toLowerCase();
                    
                    if (pType === "COMBO" && tTitle.includes("load") && (tSlot.includes("image") || tSlot.includes("video") || tSlot.includes("file"))) {
                        pType = "UPLOADER";
                    } else if (pType === "INT" && tSlot.includes("seed")) {
                        pType = "SEED";
                    }
                    
                    // ==========================================
                    // 🔥 核心修改 1：智能推导精确的小数位整数！
                    // ==========================================
                    const getPrecisionFromStep = (stepVal) => {
                        if (!stepVal || Number.isInteger(stepVal)) return 0;
                        const str = String(stepVal);
                        const decimalIdx = str.indexOf(".");
                        return decimalIdx === -1 ? 0 : str.length - decimalIdx - 1;
                    };
                    
                    let derivedPrecision = undefined;
                    if (pOpts.precision !== undefined) {
                        derivedPrecision = pOpts.precision;
                    } else if (pOpts.round !== undefined) {
                        derivedPrecision = getPrecisionFromStep(pOpts.round); // 浮点 0.01 ➡️ 整数 2 
                    } else if (pOpts.step !== undefined) {
                        derivedPrecision = getPrecisionFromStep(pOpts.step);  // 浮点 0.1 ➡️ 整数 1
                    }
                    
                    let key = `${targetNode.title || targetNode.type}_${targetSlotName}`.replace(/[^a-zA-Z0-9_]/g, "_");
                    if (config[key]) key = `${key}_${outIdx}`;
                    
                    const activeWidget = this.widgets?.find(w => w.name === key);
                    
                    // 🔥 核心修改 2：终极防覆盖！
                    // 如果控件还未在画布上生成（装载网页期），优先读取刚才保护的老存档里的值。
                    // 只有老存档里也没有，才使用原节点的 default 默认值！这彻底斩断了“自我覆写”的死锁！
                    const savedValue = (oldConfig[key] && oldConfig[key].value !== undefined) ? oldConfig[key].value : (pOpts.default !== undefined ? pOpts.default : null);
                    const activeValue = activeWidget ? activeWidget.value : savedValue;
                    
                    config[key] = { 
                        type: pType, 
                        name: `${targetSlotName} [${targetNode.title || targetNode.type}]`, 
                        default: pOpts.default, 
                            value: activeValue, // 🔥 写入被完美保护的数值
                            min: pOpts.min, 
                            max: pOpts.max, 
                            step: pOpts.step, 
                            precision: derivedPrecision, 
                            display: pOpts.display,
                            values: pValues, 
                            multiline: !!pOpts.multiline, 
                            _slot: outIdx 
                    };
                    validKeys.push(key);
                });

                // 2. 追加扫描左侧输入 (Bypasser)
                this.inputs.forEach((input, inIdx) => {
                    // 🔥 找回递增序号：配合 bypasser_ 前缀进行过滤
                    if (!input.name.startsWith("bypasser_") || !input.link) return;
                    const link = app.graph.links[input.link];
                    const originNode = app.graph.getNodeById(link.origin_id);
                    if (!originNode || originNode.type !== "AppBuilderBypasser") return;

                    const nameWidget = originNode.widgets?.find(w => w.name === "bypasser_name");
                    const bypasserName = nameWidget ? nameWidget.value.trim() : "";
                    const groupWidget = originNode.widgets?.find(w => w.name === "group_name");
                    const groupName = groupWidget ? groupWidget.value.trim() : "";
                    const matchIds = originNode.inputs.filter(inp => inp.name.startsWith("node_") && inp.link).map(inp => String(app.graph.links[inp.link].origin_id));

                    let key = `Bypasser_In_${inIdx}`;
                    const activeWidget = this.widgets?.find(w => w.name === key);
                    const savedValue = (oldConfig[key] && oldConfig[key].value !== undefined) ? oldConfig[key].value : true;
                    const activeValue = activeWidget ? activeWidget.value : savedValue;
                    
                    config[key] = {
                        type: "BYPASSER", 
                        name: bypasserName ? bypasserName : `Bypasser ${inIdx}`,
                        match_group: groupName ? [groupName] : null,
                        match_id: matchIds.length > 0 ? matchIds : null,
                        default: true,
                        value: activeValue, // 🔥 写入保护值
                        _slot: 100 + inIdx 
                    };
                    validKeys.push(key);
                });

                if (jsonW) jsonW.value = JSON.stringify(config);

                // 3. 更新画布上的 Widget
                const hasActiveSeed = Object.values(config).some(p => p.type === "SEED");
                const hasActiveUploader = Object.values(config).some(p => p.type === "UPLOADER");
                
                let seenControlAfterGenerate = false; // 🔥 种子伴生去重指示器
                
                for (let i = this.widgets.length - 1; i >= 0; i--) {
                    const w = this.widgets[i];
                    
                    if (w.value === "Upload" && !w.associatedKey) {
                        this.widgets.splice(i, 1);
                        continue;
                    }
                    
                    // A. 🔥 升级：如果没有任何种子，直接清理伴生选项框；如果有多余的伴生框，通通就地抹杀！
                    if (w.name === "control_after_generate") {
                        if (!hasActiveSeed) {
                            this.widgets.splice(i, 1);
                            continue;
                        } else {
                            if (seenControlAfterGenerate) {
                                this.widgets.splice(i, 1); // 发现第二个副本，直接物理消灭！
                                continue;
                            } else {
                                seenControlAfterGenerate = true; // 标记我们已经保留了唯一的一个
                            }
                        }
                    }
                    
                    // B. 如果是上传按钮，且它关联的插槽已断开，瞬间物理拔除！
                    if (w.value === "Upload" && w.associatedKey) {
                        if (!validKeys.includes(w.associatedKey) || !hasActiveUploader) {
                            this.widgets.splice(i, 1);
                            continue;
                        }
                    }
                    
                    // 保护过滤名单：加入了对活动中上传按钮的保护
                    const isProtected = [
                        "config_json", "control_after_generate", "btn_app_view", 
                        "converted-widget", "hidden_parameter"
                    ].includes(w.name) || w.value === "btn_app_view" || w.type === "hidden_parameter" || 
                    (w.value === "Upload" && w.associatedKey && validKeys.includes(w.associatedKey)); // 🔥 保护活跃的上传按钮
                    
                    if (!isProtected && !validKeys.includes(w.name)) {
                        this.widgets.splice(i, 1);
                    }
                }

                // 4. 创建或更新控件 (终极防类型锁死版)
                Object.entries(config).forEach(([key, param]) => {
                    let defaultVal = param.value !== undefined ? param.value : param.default;
                    if (defaultVal === null || defaultVal === undefined) {
                        if (param.type === "COMBO" || param.type === "UPLOADER") {
                            defaultVal = param.values ? param.values[0] : "None";
                        } else if (param.type === "INT" || param.type === "FLOAT" || param.type === "SEED") {
                            defaultVal = 0;
                        } else if (param.type === "BOOLEAN") {
                            defaultVal = true;
                        } else {
                            defaultVal = "";
                        }
                    }
                    
                    let existingW = this.widgets.find(w => w.name === key);
                    
                    // ==========================================
                    // 🔥 核心防锁死锁：如果已有控件类型与最新参数类型不符，强行当场摧毁！
                    // ==========================================
                    if (existingW) {
                        let currentWType = String(existingW.type).toUpperCase();
                        let targetWType = String(param.type).toUpperCase();
                        
                        // 统一类型代号映射，用于比对
                        if (targetWType === "FLOAT" || targetWType === "INT" || targetWType === "SEED") targetWType = "NUMBER";
                        if (targetWType === "BOOLEAN") targetWType = "TOGGLE";
                        if (targetWType === "STRING") targetWType = "TEXT";
                        if (targetWType === "UPLOADER") targetWType = "COMBO";
                        
                        // 如果发现类型发生了冲突（比如数字框/文本框现在应该是下拉框了）
                        if (currentWType !== targetWType && !(currentWType === "CONVERTED-WIDGET" && targetWType === "NUMBER")) {
                            const wIdx = this.widgets.indexOf(existingW);
                            if (wIdx !== -1) {
                                if (existingW.onRemove) existingW.onRemove();
                                this.widgets.splice(wIdx, 1); // 强行从队列中抹除！
                                existingW = null; // 置空，使其能够完美进入下面的 !existingW 新建分支！
                            }
                        }
                    }
                        
                    if (param.type === "UPLOADER") {
                        existingW = setupUploaderWidget(this, key, param, defaultVal, validKeys);
                        if (existingW) {
                            const origCallback = existingW.callback;
                            existingW.callback = (v) => {
                                saveWidgetValueToConfig(this, key, v);
                                if (origCallback) origCallback(v);
                            };
                        }
                    } else if (!existingW) {
                        // 首次创建或被摧毁重建分支
                        if (param.type === "BYPASSER") {
                            existingW = this.addWidget("toggle", key, true, (v) => {
                                const currentJsonW = this.widgets?.find(w => w.name === "config_json");
                                if (currentJsonW && currentJsonW.value) {
                                    try {
                                        const currentConfig = JSON.parse(currentJsonW.value);
                                        const currentParam = currentConfig[key];
                                        if (currentParam) {
                                            applyBypasser(v, currentParam, app.graph);
                                        }
                                    } catch(e) { console.error(e); }
                                }
                                saveWidgetValueToConfig(this, key, v); // 🔥 归档
                            }, {});
                            setTimeout(() => {
                                if (existingW) applyBypasser(existingW.value, param, app.graph);
                            }, 100);
                        } else if (param.type === "SEED") {
                            existingW = ComfyWidgets.INT(this, key, ["INT", { 
                                default: defaultVal, min: param.min ?? 0, max: param.max ?? 0xffffffffffffffff, control_after_generate: true 
                            }], app).widget;
                            if (existingW) existingW.callback = (v) => saveWidgetValueToConfig(this, key, v);
                        } else if (param.type === "COMBO") {
                            existingW = this.addWidget("combo", key, defaultVal, ()=>{}, {values: param.values});
                        } else if (param.type === "INT" || param.type === "FLOAT") {
                            const isInt = param.type === "INT";
                            const step = param.step ?? (isInt ? 1 : 0.1);
                            
                            // ComfyUI 官方标准：INT 精度为 0，FLOAT 默认精度为 3
                            const prec = param.precision ?? (isInt ? 0 : 3);
                            
                            // 判定是否渲染为滑块
                            const isSlider = param.display === "slider" || param.slider === true;
                            const hasBounds = param.min !== undefined && param.max !== undefined;
                            const useSlider = isSlider && hasBounds;
                            
                            const minVal = param.min ?? -999999;
                            const maxVal = param.max ?? 999999;
                            
                            // 🔥 终极黑魔法：普通数字框必须乘以 10 抵消 LiteGraph 底层 Bug，滑块则用原值！
                            const widgetStep = useSlider ? step : step * 10;
                            
                            existingW = this.addWidget(useSlider ? "slider" : "number", key, defaultVal, (v)=>{
                                saveWidgetValueToConfig(this, key, v);
                            }, { 
                                min: minVal, max: maxVal, step: widgetStep, precision: prec 
                            });
                        } else {
                            existingW = this.addWidget("text", key, defaultVal, (v) => saveWidgetValueToConfig(this, key, v), {});
                        }
                        existingW.label = param.name; 
                    } else {
                        // 已存在且类型相符的更新分支
                        existingW.label = param.name;
                        existingW.callback = (v) => saveWidgetValueToConfig(this, key, v);
                    }
                });
                // ==========================================
                // 🔥 核心修改：对 widgets 数组重新排序，强制视觉顺序与连线顺序100%对齐！
                // ==========================================
                const staticWidgets = this.widgets.filter(w => 
                    w.name === "config_json" || 
                    w.name === "converted-widget" || 
                    w.type === "hidden_parameter" || 
                    w.name === "btn_app_view" || 
                    w.value === "btn_app_view"
                );
                
                const sortedDynamicWidgets = [];
                Object.keys(config).forEach(key => {
                    const w = this.widgets.find(wd => wd.name === key);
                    if (w) {
                        sortedDynamicWidgets.push(w);
                        
                        // 种子伴随
                        if (config[key].type === "SEED") {
                            const companion = this.widgets.find(c => c.name === "control_after_generate");
                            if (companion) sortedDynamicWidgets.push(companion);
                        }
                        
                        // 🔥 重点：上传伴随。一旦发现 Uploader 控件，立刻让它的专属 Upload 按钮紧贴其下！
                        if (config[key].type === "UPLOADER") {
                            const uploadBtn = this.widgets.find(u => u.value === "Upload" && u.associatedKey === key);
                            if (uploadBtn) sortedDynamicWidgets.push(uploadBtn);
                        }
                    }
                });
                
                // 防止漏网之鱼（防御性代码）
                const remainingWidgets = this.widgets.filter(w => 
                    !staticWidgets.includes(w) && 
                    !sortedDynamicWidgets.includes(w)
                );
                
                // 🔥 重新组装底层的 widgets 数组，刷新视觉渲染顺序！
                this.widgets = [...staticWidgets, ...sortedDynamicWidgets, ...remainingWidgets];
                
                // 计算高度并刷新画布
                //this.setSize(this.computeSize());
                this.setDirtyCanvas(true, true);
            };
        }
    }
});
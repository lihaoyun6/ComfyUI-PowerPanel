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
    name: "PowerPanel.PowerParameterPanel",
    
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
                    const nodes = app.graph.findNodesByType("PowerParameterPanel");
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
                    if (node.class_type === "PowerParameterPanel") {
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
                    if (node.class_type === "PowerParameterPanel" || node.class_type === "ParametersUnpacker") continue;
                    
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
                    if (prompt[nodeId].class_type === "PowerParameterPanel" || prompt[nodeId].class_type === "ParametersUnpacker") {
                        delete prompt[nodeId];
                    }
                }
            } catch(e) {
                console.error("[PowerPanel] Graph interception failed:", e);
            }
            return res; 
        };
    },
    
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "PowerParameterPanel") {
            
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

                    if (this._onPreview) {
                        api.removeEventListener("b_preview", this._onPreview);
                        api.removeEventListener("executed", this._onExecuted);
                        api.removeEventListener("execution_start", this._onStart);
                        api.removeEventListener("status", this._onStatus);
                        api.removeEventListener("execution_interrupted", this._onInterrupted);
                        api.removeEventListener("progress", this._onProgress);
                        api.removeEventListener("execution_error", this._onExecutionError);
                    }

                    this._onPreview = onPreview;
                    this._onExecuted = onExecuted;
                    this._onStart = onStart;
                    this._onStatus = onStatus;
                    this._onInterrupted = onInterrupted;
                    this._onProgress = onProgress;
                    this._onExecutionError = onExecutionError;

                    api.addEventListener("b_preview", onPreview);
                    api.addEventListener("executed", onExecuted);
                    api.addEventListener("execution_start", onStart);
                    api.addEventListener("status", onStatus);
                    api.addEventListener("execution_interrupted", onInterrupted);
                    api.addEventListener("progress", onProgress);
                    api.addEventListener("execution_error", onExecutionError);
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
                    }
                    if (onRemoved) onRemoved.apply(this, arguments);
                };

                // 👇【核心修改：只添加一个配置按钮，完全删除旧的 Lock / Update 等繁琐组件】
                this.addWidget("button", "⚙️ Configure Panel", "btn_configure", () => {
                    openConfigOverlay(this.id);
                });

                this.addWidget("button", "📱 Open in AppView", "btn_app_view", () => {
                    const htmlUrl = new URL('app_view.html', import.meta.url);
                    htmlUrl.searchParams.set('nodeId', this.id); 
                    
                    const appWindow = window.open(htmlUrl.href, '_blank');
                    if (!appWindow) {
                        alert("Please allow pop-ups for this site to open the AppView.");
                        return;
                    }
                    this.registerAppWindow(appWindow);
                });
                
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
                                    const response = await fetch(`/power_panel/ls/${params.folder}`);
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
                            let inputFiles = ["None"];
                            if (app.node_defs && app.node_defs["LoadImage"]) {
                                inputFiles = app.node_defs["LoadImage"].input.required.image[0];
                            } else if (val) {
                                inputFiles = [val];
                            }
                            
                            const comboWidget = this.addWidget("combo", key, val || inputFiles[0], (v) => {
                                this.notifyUnpackers();
                            }, { values: inputFiles });
                            
                            widget = comboWidget;

                            const uploadBtn = this.addWidget("button", "Choose File", "Upload", () => {
                                const fileInput = document.createElement("input");
                                fileInput.type = "file";
                                const mediaType = params.media || 'image';
                                if (mediaType === 'image') fileInput.accept = 'image/*';
                                else if (mediaType === 'video') fileInput.accept = 'video/*';
                                else if (mediaType === 'audio') fileInput.accept = 'audio/*';
                                else fileInput.accept = 'image/*,video/*,audio/*';

                                fileInput.onchange = async () => {
                                    if (fileInput.files.length > 0) {
                                        const file = fileInput.files[0];
                                        uploadBtn.value = "Uploading...";
                                        this.setDirtyCanvas(true, true);

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
                                                uploadBtn.value = "Success ✅";
                                                
                                                if (comboWidget.callback) comboWidget.callback(result.name);
                                                
                                                this.notifyUnpackers(); 
                                            } else {
                                                uploadBtn.value = "Failed ❌";
                                            }
                                        } catch (e) {
                                            console.error(e);
                                            uploadBtn.value = "Error ❌";
                                        }
                                        this.setDirtyCanvas(true, true);
                                        setTimeout(() => {
                                            uploadBtn.value = "Upload";
                                            this.setDirtyCanvas(true, true);
                                        }, 2000);
                                    }
                                };
                                fileInput.click();
                            });
                            uploadBtn.serialize = false;
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
                    if (!upstreamNode || upstreamNode.type !== "PowerParameterPanel") return;
                    
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
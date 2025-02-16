import { EventEmitter } from "events";
import * as path from "path";
import * as process from "process";
import { v4 as uuidv4 } from "uuid";
import * as cls from "cls-hooked";
import * as semver from "semver";
import { pathExists } from "fs-extra";
import { instrument as instrumentTrace } from "stacktrace-js";
import { check as tcpPortUsed } from "tcp-port-used";
import * as getCPUUsage from "cpu-percentage";

import {
    APIVersion,
    Agent,
    AgentDownloadOptions,
    AgentDownloader,
    AgentEvent,
    ApplicationEventType,
    ApplicationMetadata,
    BaseAgentRequest,
    BaseAgentResponse,
    CoreAgentVersion,
    JSONValue,
    LogFn,
    LogLevel,
    ProcessOptions,
    ScoutConfiguration,
    ScoutContextName,
    ScoutEvent,
    ScoutTag,
    AgentSocketType,
    URIReportingLevel,
    buildDownloadOptions,
    buildProcessOptions,
    buildScoutConfiguration,
    generateTriple,
    isLogLevel,
    parseLogLevel,
    scrubRequestPath,
    scrubRequestPathParams,
    isIgnoredLogMessage,
} from "../types";
import { setActiveGlobalScoutInstance, EXPORT_BAG } from "../global";
import { getIntegrationForPackage } from "../integrations";

import WebAgentDownloader from "../agent-downloaders/web";
import ExternalProcessAgent from "../agents/external-process";
import * as Requests from "../protocol/v1/requests";
import * as Constants from "../constants";
import * as Errors from "../errors";

export { default as ScoutRequest } from "./request";
export { default as ScoutSpan } from "./span";

import ScoutRequest from "./request";
import { ScoutRequestOptions } from "./request";
import ScoutSpan from "./span";

export interface ScoutEventRequestSentData {
    request: ScoutRequest;
}

export interface ScoutOptions {
    // Function to be used for logging
    logFn?: LogFn;

    // Options that control the way in which scout will perform it's core-agent download
    downloadOptions?: Partial<AgentDownloadOptions>;

    // Additional application metadata
    appMeta?: ApplicationMetadata;

    // The threshold for slow requests
    slowRequestThresholdMs?: number;

    // Amount of time between calculating and sending statistics
    statisticsIntervalMS?: number;
}

export interface CallbackInfo {
    span?: ScoutSpan;
    parent?: ScoutSpan | ScoutRequest;
    request?: ScoutRequest;
}

export type DoneCallback = (
    done: () => void,
    info: CallbackInfo,
) => any;

const DONE_NOTHING = () => undefined;

export type SpanCallback = (info: CallbackInfo) => any;
export type RequestCallback = (info: CallbackInfo) => any;

const ASYNC_NS = "scout";
const ASYNC_NS_REQUEST = `${ASYNC_NS}.request`;
const ASYNC_NS_SPAN = `${ASYNC_NS}.span`;

export class Scout extends EventEmitter {
    private readonly config: Partial<ScoutConfiguration>;

    private downloader: AgentDownloader;
    private downloaderOptions: AgentDownloadOptions = {};
    private binPath: string;
    private logFn: LogFn;
    private slowRequestThresholdMs: number = Constants.DEFAULT_SLOW_REQUEST_THRESHOLD_MS;

    private coreAgentVersion: CoreAgentVersion;
    private agent: ExternalProcessAgent | null;
    private processOptions: ProcessOptions;
    private applicationMetadata: ApplicationMetadata;

    private asyncNamespace: any;
    private syncCurrentRequest: ScoutRequest | null = null;
    private syncCurrentSpan: ScoutSpan | null = null;

    private uncaughtExceptionListenerFn: (err) => void;

    private settingUp: Promise<this>;

    private statsSendingInterval?: NodeJS.Timeout;
    private statsIntervalMS?: number;
    private cpuUsageStart = getCPUUsage();

    constructor(config?: Partial<ScoutConfiguration>, opts?: ScoutOptions) {
        super();

        this.config = config || buildScoutConfiguration();

        if (opts) {
            if (opts.logFn) { this.logFn = opts.logFn; }

            if (opts.downloadOptions) { this.downloaderOptions = opts.downloadOptions; }
            if (opts.slowRequestThresholdMs) { this.slowRequestThresholdMs = opts.slowRequestThresholdMs; }
            if (opts.statisticsIntervalMS) { this.statsIntervalMS  = opts.statisticsIntervalMS; }
        }

        this.applicationMetadata = new ApplicationMetadata(
            this.config,
            opts && opts.appMeta ? opts.appMeta : {},
        );

        let version = this.config.coreAgentVersion || Constants.DEFAULT_CORE_AGENT_VERSION;
        if (version[0] === "v") { version = version.slice(1); }

        // Build expected bin & socket path based on current version
        const triple = generateTriple();
        this.binPath = path.join(
            Constants.DEFAULT_CORE_AGENT_DOWNLOAD_CACHE_DIR,
            `scout_apm_core-v${version}-${triple}`,
            Constants.CORE_AGENT_BIN_FILE_NAME,
        );

        // If the passed-in logging function (saved @ logFn) has a 'logger' property which has a correposnding level
        // attempt to set the log level to the passed in logger's level
        if (this.logFn && this.logFn.logger && this.logFn.logger.level && isLogLevel(this.logFn.logger.level)) {
            this.config.logLevel = parseLogLevel(this.logFn.logger.level);
        }

        // Create async namespace if it does not exist
        this.createAsyncNamespace();
    }

    public log(message: string, level: LogLevel = LogLevel.Info) {
        if (!this.logFn) { return; }
        if (!this.config || !this.config.logLevel) { return; }

        if (isIgnoredLogMessage(this.config.logLevel, level)) {
            return;
        }

        return this.logFn(message, level);
    }

    private get socketPath() {
        if (this.config.socketPath) {
            return this.config.socketPath;
        }

        // Only core-agents version less than CORE_AGENT_TCP_SOCKET_MIN_VERSION
        // use a unix socket path based on the default socket file name as the default
        if (semver.lt(this.coreAgentVersion.raw, Constants.CORE_AGENT_TCP_SOCKET_MIN_VERSION)) {
            return this.getDefaultSocketFilePath();
        }

        // For core agents newer than CORE_AGENT_TCP_SOCKET_MIN_VERSION, use TCP
        return `tcp://${Constants.CORE_AGENT_TCP_DEFAULT_HOST}:${Constants.CORE_AGENT_TCP_DEFAULT_PORT}`;
    }

    protected getDefaultSocketFilePath(): string {
        return path.join(
            path.dirname(this.binPath),
            Constants.DEFAULT_SOCKET_FILE_NAME,
        );
    }

    /**
     * Start sending statistics for the node process
     *
     * @return {Promise<void>} A promise that resolves when the statistics sending has started
     */
    protected startSendingStatistics(): void {
        if (this.statsSendingInterval) { return; }

        this.log("[scout] Starting sending of statistics...", LogLevel.Info);

        this.statsSendingInterval = setInterval(() => {
            if (!this.agent) {
                // A shutdown likey occurred
                this.log("[scout] Disabling stats sending interval since agent is missing...", LogLevel.Debug);
                if (this.statsSendingInterval) { clearInterval(this.statsSendingInterval); }
                return;
            }

            const pid = process.pid;

            // Gather metrics
            this.log("`[scout] Gathering CPU & memory usage statistics...", LogLevel.Debug);

            // Send memory metric
            const memoryUsageMB = process.memoryUsage().rss / (1024 * 1024);
            this.agent.sendAsync(new Requests.V1ApplicationEvent(
                `Pid: ${pid}`,
                ApplicationEventType.MemoryUsageMB,
                memoryUsageMB,
            ));

            // Calculate the CPU usage since last measurement, send percentage
            const cpuUsagePercent = getCPUUsage(this.cpuUsageStart).percent * 100;
            this.cpuUsageStart = getCPUUsage();
            this.agent.sendAsync(new Requests.V1ApplicationEvent(
                `Pid: ${pid}`,
                ApplicationEventType.CPUUtilizationPercent,
                cpuUsagePercent,
            ));

        }, this.statsIntervalMS || Constants.DEFAULT_STATS_INTERVAL_MS);
    }

    /**
     * Stop sending statistics for the node process
     *
     * @return {Promise<void>} A promise that resolves when the statistics sending has stoped
     */
    protected stopSendingStatistics(): void {
        if (!this.statsSendingInterval) { return; }

        this.log("[scout] Stopping sending of statistics...", LogLevel.Info);
        clearInterval(this.statsSendingInterval);
    }

    public getSocketType(): AgentSocketType {
        if (this.socketPath.startsWith("tcp://")) { return AgentSocketType.TCP; }
        return AgentSocketType.Unix;
    }

    public getSocketPath() {
        return this.getSocketType() === AgentSocketType.TCP ? this.socketPath : `unix://${this.socketPath}`;
    }

    public getSocketFilePath(): string | null {
        if (this.getSocketType() !== AgentSocketType.Unix) { return null; }
        return this.socketPath.slice();
    }

    public getCoreAgentVersion(): CoreAgentVersion {
        return new CoreAgentVersion(this.coreAgentVersion.raw);
    }

    public getApplicationMetadata(): ApplicationMetadata {
        return Object.assign({}, this.applicationMetadata);
    }

    public getConfig(): Partial<ScoutConfiguration> {
        return this.config;
    }

    public getAgent(): ExternalProcessAgent | null {
        return this.agent;
    }

    public getSlowRequestThresholdMs(): number {
        return this.slowRequestThresholdMs;
    }

    /**
     * Helper to facilitate non-blocking setup
     *
     * @throws ScoutSettingUp if the scout instance is still setting up (rather than waiting)
     */
    public setupNonBlocking(): Promise<this> {
        if (!this.settingUp) { return this.setup(); }

        return Promise.race([this.settingUp, Promise.reject(new Errors.InstanceNotReady())]);
    }

    public setup(): Promise<this> {
        // Return early if agent has already been set up
        if (this.agent) { return Promise.resolve(this); }

        // If setting up has already begun return that
        if (this.settingUp) { return this.settingUp; }

        this.log("[scout] setting up scout...", LogLevel.Debug);

        const shouldLaunch = this.config.coreAgentLaunch;

        const doLaunch = shouldLaunch ? this.downloadAndLaunchAgent() : this.createAgentForExistingSocket();

        // If the socket path exists then we may be able to skip downloading and launching
        this.settingUp = doLaunch
            .then(() => {
                if (!this.agent) { throw new Errors.NoAgentPresent(); }
                return this.agent.connect();
            })
            .then(() => this.log("[scout] successfully connected to agent", LogLevel.Debug))
            .then(() => {
                if (!this.config.name) {
                    this.log("[scout] 'name' configuration value missing", LogLevel.Warn);
                }
                if (!this.config.key) {
                    this.log("[scout] 'key' missing in configuration", LogLevel.Warn);
                }
            })
        // Register the application
            .then(() => {
                if (!this.agent) { throw new Errors.NoAgentPresent(); }
                return this.agent.setRegistrationAndMetadata(
                    new Requests.V1Register(
                        this.config.name || "",
                        this.config.key || "",
                        APIVersion.V1,
                    ),
                    this.buildAppMetadataEvent(),
                );
            })
        // Send the registration and app metadata
            .then(() => this.sendRegistrationRequest())
            .then(() => this.sendAppMetadataEvent())
        // Set up integration(s)
            .then(() => this.setupIntegrations())
        // Set up process uncaught exception handler
            .then(() => {
                this.uncaughtExceptionListenerFn = (err) => this.onUncaughtExceptionListener(err);
                process.on("uncaughtException", this.uncaughtExceptionListenerFn);
            })
        // Set up this scout instance as the global one, if there isn't already one
            .then(() => setActiveGlobalScoutInstance(this))
        // Start the statistics sending interval
            .then(() => this.startSendingStatistics())
            .then(() => this);

        return this.settingUp;
    }

    public shutdown(): Promise<void> {
        // Disable the statistics sending interval if present
        if (this.statsSendingInterval) {
            this.stopSendingStatistics();
        }

        // Ensure an agent is present bfore we attempt to shut it down
        if (!this.agent) {
            this.log("[scout] shutdown called but no agent to shutdown is present", LogLevel.Error);
            return Promise.reject(new Errors.NoAgentPresent());
        }

        // Disable the uncaughtException listener
        if (this.uncaughtExceptionListenerFn) {
            process.removeListener("uncaughtException", this.uncaughtExceptionListenerFn);
        }

        return this.agent
            .disconnect()
            .then(() => {
                if (this.config.allowShutdown && this.agent) {
                    return this.agent.stopProcess();
                }
            })
        // Remove the agent, emit the shutdown event
            .then(() => {
                this.agent = null;
                this.emit(ScoutEvent.Shutdown);
            });
    }

    public hasAgent(): boolean {
        return typeof this.agent !== "undefined" && this.agent !== null;
    }

    public isShutdown(): boolean {
        return this.agent === null;
    }

    /**
     * Function for checking whether a given path (URL) is ignored by scout
     *
     * @param {string} path - processed path (ex. "/api/v1/echo/:name")
     * @returns {boolean} whether the path should be ignored
     */
    public ignoresPath(path: string): boolean {
        this.log("[scout] checking path [${path}] against ignored paths", LogLevel.Debug);

        // If ignore isn't specified or if empty, then nothing is ignored
        if (!this.config.ignore || this.config.ignore.length === 0) {
            return false;
        }

        const matchingPrefix = this.config.ignore.find(prefix => path.indexOf(prefix) === 0);

        if (matchingPrefix) {
            this.log("[scout] ignoring path [${path}] matching prefix [${matchingPrefix}]", LogLevel.Debug);
            this.emit(ScoutEvent.IgnoredPathDetected, path);
        }

        return matchingPrefix !== undefined;
    }

    /**
     * Filter a given request path (ex. /path/to/resource) according to logic before storing with Scout
     *
     * @param {string} path
     * @returns {URL} the filtered URL object
     */
    public filterRequestPath(path: string): string {
        switch (this.config.uriReporting) {
            case URIReportingLevel.FilteredParams:
                return scrubRequestPathParams(path);
            case URIReportingLevel.Path:
                return scrubRequestPath(path);
            default:
                return path;
        }
    }

    /**
     * Start a transaction
     *
     * @param {string} name
     * @param {Function} callback
     * @returns void
     */
    public transaction(name: string, cb: DoneCallback): Promise<any> {
        this.log(`[scout] Starting transaction [${name}]`, LogLevel.Debug);

        let ranContext = false;

        // Setup if necessary then then perform the async request context
        return this.setup()
            .then(() => {
                ranContext = true;
                return this.withAsyncRequestContext(cb);
            })
            .catch(err => {
                this.log("[scout] Scout setup failed: ${err}", LogLevel.Error);
                if (!ranContext) {
                    return this.withAsyncRequestContext(cb);
                }
            });
    }

    /**
     * Start a synchronous transaction
     *
     * @param {string} name
     */
    public transactionSync(name: string, fn: RequestCallback): any {
        this.log(`[scout] Starting transaction [${name}]`, LogLevel.Debug);

        // Create & start the request synchronously
        const request = this.startRequestSync();
        this.syncCurrentRequest = request;

        const result = fn({request});
        request.stopSync();

        // Reset the current request as sync
        this.syncCurrentRequest = null;

        // Fire and forget the request
        request.finishAndSend();

        return result;
    }

    /**
     * Start an instrumentation, within a given transaction
     *
     * @param {string} operation
     * @param {Function} cb
     * @returns {Promise<any>} a promsie that resolves to the result of the callback
     */
    public instrument(operation: string, cb: DoneCallback): Promise<any> {
        const parent = this.getCurrentSpan() || this.getCurrentRequest() || undefined;
        const request = this.getCurrentRequest() || undefined;
        const parentIsSpan = parent !== request;

        this.log(
            `[scout] Instrumenting operation [${operation}], parent? [${parent ? parent.id : "NONE"}]`,
            LogLevel.Debug,
        );

        // Create a transaction if instrument was called without an encapsulating request
        if (!parent && !request) {
            this.log("[scout] Creating request for instrumentation", LogLevel.Warn);
            return this.transaction(operation, transactionDone => {
                // Create a modified callback which finishes the transaction after first instrumentation
                const modifiedCb = (spanDone, info) => {
                    // Call the original callback, but give it a done function that finished the span
                    // *and* the request, and pass along the info
                    return cb(() => spanDone().then(() => transactionDone()), info);
                };

                return this.instrument(operation, modifiedCb);
            });
        }

        // Both parent and request must be present -- no span can start
        // without a parent request (and that would be the parent)
        if (!parent || !request) {
            this.log(
                "[scout] Failed to start instrumentation, no current transaction/parent instrumentation",
                LogLevel.Error,
            );
            return Promise.resolve(cb(DONE_NOTHING, {}));
        }

        let result;
        let ranCb = false;

        this.log(
            `[scout] Starting child span for operation [${operation}], parent id [${parent.id}]`,
            LogLevel.Debug,
        );

        let span: ScoutSpan;

        return new Promise((resolve, reject) => {
            // Create a new async context for the instrumentation
            this.asyncNamespace.run(() => {
                // Create a done function that will clear the entry and stop the span
                const doneFn = () => {
                    // Set the parent for other sibling/same-level spans
                    if (parentIsSpan) {
                        // If the parent of this span is a span, then we want other spans in this namespace
                        // to be children of that parent span, so save the parent
                        this.asyncNamespace.set(ASYNC_NS_SPAN, parent);
                    } else {
                        // If the parent of this span *not* a span,
                        // then the parent of sibling spans should be the request,
                        // so we can clear the current span entry
                        this.clearAsyncNamespaceEntry(ASYNC_NS_SPAN);

                        this.clearAsyncNamespaceEntry(ASYNC_NS_REQUEST);
                    }

                    // If we never made the span object then don't do anything
                    if (!span) { return Promise.resolve(); }

                    // If we did create the span, note that it was stopped successfully
                    this.log(`[scout] Stopped span with ID [${span.id}]`, LogLevel.Debug);

                    return Promise.resolve();
                };

                // If parent has become invalidated, then run the callback and exit
                if (!parent) {
                    resolve(cb(DONE_NOTHING, {}));
                    return;
                }

                // Create & start a child span on the current parent (request/span)
                parent
                    .startChildSpan(operation)
                    .then(s => span = s)
                    .then(() => {
                        // Set the span & request on the namespace
                        this.asyncNamespace.set(ASYNC_NS_REQUEST, request);
                        this.asyncNamespace.set(ASYNC_NS_SPAN, span);

                        // Set function to call on finish
                        span.setOnStop(() => {
                            const result = doneFn();
                            if (span) { span.clearOnStop(); }
                            return result;
                        });

                        // Set that the cb has been run, in the case of error so we don't run twice
                        ranCb = true;
                        const result = cb(() => span.stop(), {span, request, parent});

                        // Ensure that the result is a promise
                        resolve(result);
                    })
                // Return the result
                    .catch(err => {
                        // NOTE: it is possible for span to be missing here if startChildSpan() fails
                        if (!span) {
                            this.log(
                                "[scout] error during instrument(), startChildSpan likely failed\n ERROR: ${err}",
                                LogLevel.Error,
                            );
                        }

                        // It's possible that an error happened *before* the callback could be run
                        if (!ranCb) {
                            result = cb(() => span && span.stop(), {span, request, parent});
                        }

                        this.log("[scout] failed to send start span", LogLevel.Error);
                        // Ensure that the result is a promise
                        resolve(result);
                    });
            });
        });
    }

    /**
     * Instrumentation for synchronous methods
     *
     * @param {string} operation - operation name for the span
     * @param {SpanCallback} fn - function to execute
     * @param {ScoutRequest} [requestOverride] - The request on which to start the span to execute
     * @throws {NoActiveRequest} If there is no request in scope (via async context or override param)
     */
    public instrumentSync(operation: string, fn: SpanCallback, requestOverride?: ScoutRequest): any {
        let parent = requestOverride || this.syncCurrentSpan || this.syncCurrentRequest;
        // Check the async sources in case we're in a async context but not a sync one
        parent = parent || this.getCurrentSpan() || this.getCurrentRequest();

        // If there isn't a current parent for instrumentSync, auto create one
        if (!parent) {
            this.log(
                "[scout] parent context missing for synchronous instrumentation (via async context or passed in)",
                LogLevel.Warn,
            );

            return this.transactionSync(operation, () => this.instrumentSync(operation, fn));
        }

        // Start a child span of the parent synchronously
        const span = parent.startChildSpanSync(operation);
        this.syncCurrentSpan = span;

        span.startSync();
        const result = fn({
            span,
            parent,
            request: this.getCurrentRequest() || undefined,
        });
        span.stopSync();

        // Clear out the current span for synchronous operations
        this.syncCurrentSpan = null;

        return result;
    }

    /**
     * Add context to the current transaction/instrument
     *
     * @param {ScoutTag} tag
     * @returns {Promise<void>} a promsie that resolves to the result of the callback
     */
    public addContext(
        name: string,
        value: JSONValue | JSONValue[],
        parentOverride?: ScoutRequest | ScoutSpan,
    ): Promise<ScoutRequest | ScoutSpan | void> {
        let parent = this.getCurrentSpan() || this.getCurrentRequest();

        // If we're not in an async context then attempt to use the sync parent span or request
        if (!parent) { parent = this.syncCurrentSpan || this.syncCurrentRequest; }

        // If a parent override was provided, use it
        if (parentOverride) { parent = parentOverride; }

        // If no request is currently underway
        if (!parent) {
            this.log("[scout] Failed to add context, no current parent instrumentation", LogLevel.Error);
            return Promise.resolve();
        }

        this.log(`[scout] Adding context (${name}, ${value}) to parent ${parent.id}`, LogLevel.Debug);

        return parent.addContext(name, value);
    }

    /**
     * Retrieve the current request using the async hook/continuation local storage machinery
     *
     * @returns {ScoutRequest} the current active request
     */
    public getCurrentRequest(): ScoutRequest | null {
        try {
            const req = this.asyncNamespace.get(ASYNC_NS_REQUEST);
            return req || this.syncCurrentRequest;
        } catch {
            return null;
        }
    }

    /**
     * Retrieve the current span using the async hook/continuation local storage machinery
     *
     * @returns {ScoutSpan} the current active span
     */
    public getCurrentSpan(): ScoutSpan | null {
        try {
            const span = this.asyncNamespace.get(ASYNC_NS_SPAN);
            return span || this.syncCurrentSpan;
        } catch {
            return null;

        }
    }

    // Setup integrations
    public setupIntegrations() {
        Object.keys(EXPORT_BAG)
            .map(packageName => getIntegrationForPackage(packageName))
            .forEach(integration => integration.setScoutInstance(this));
    }

    /**
     * Check if an agent is already running
     *
     * @returns {Promise<boolean>}
     */
    public agentIsRunning(socketPath): Promise<boolean> {
        const socketType = this.getSocketType();

        if (socketType === AgentSocketType.Unix) {
            return pathExists(socketPath);
        }

        if (socketType === AgentSocketType.TCP) {
          const [_, __, portRaw] = socketPath.split(":");
          const port = parseInt(portRaw, 10);
          return tcpPortUsed(port);
        }

        return Promise.reject(new Errors.UnknownSocketType());
    }

    /**
     * Attempt to clear an async name space entry
     *
     * this.asyncNamespace.set can fail if the async context ID is already gone
     * before someone tries to clear it. This can happen if some caller moves calls to
     * another async context or if it's cleaned up suddenly
     */
    private clearAsyncNamespaceEntry(key: string) {
        try {
            this.asyncNamespace.set(key, undefined);
        } catch {
            // this.logFn("failed to clear async namespace", LogLevel.Debug);
        }
    }

    // Helper for creating an ExternalProcessAgent for an existing, listening agent
    private createAgentForExistingSocket(socketPath?: string): Promise<ExternalProcessAgent> {
        this.log(`[scout] detected existing socket @ [${this.socketPath}], skipping agent launch`, LogLevel.Debug);

        socketPath = socketPath || this.socketPath;

        // Check if the socketPath exists
        return this.agentIsRunning(socketPath)
            .then(exists => {
                if (!exists) {
                    throw new Errors.InvalidConfiguration("socket @ path [${socketPath}] does not exist");
                }
            })
        // Build process options and agent
            .then(() => {
                this.processOptions = new ProcessOptions(
                    this.binPath,
                    this.getSocketPath(),
                    buildProcessOptions(this.config),
                );

                return new ExternalProcessAgent(this.processOptions, this.log);
            })
            .then(agent => this.setupAgent(agent));
    }

    // Helper for downloading and launching an agent
    private downloadAndLaunchAgent(): Promise<ExternalProcessAgent> {
        this.log(`[scout] downloading and launching agent`, LogLevel.Debug);
        this.downloader = new WebAgentDownloader({logFn: this.log});

        // Ensure coreAgentVersion is present
        if (!this.config.coreAgentVersion) {
            const err = new Error("No core agent version specified!");
            this.log(err.message, LogLevel.Error);
            return Promise.reject(err);
        }

        this.coreAgentVersion = new CoreAgentVersion(this.config.coreAgentVersion);

        // Build options for download
        this.downloaderOptions = Object.assign(
            {
                cacheDir: path.dirname(this.binPath),
                updateCache: true,
            },
            this.downloaderOptions,
            buildDownloadOptions(this.config),
        );

        // Download the appropriate binary
        return this.downloader
            .download(this.coreAgentVersion, this.downloaderOptions)
            .then(bp => {
                this.binPath = bp;
                this.log(`[scout] using socket path [${this.socketPath}]`, LogLevel.Debug);
            })
        // Build options for the agent and create the agent
            .then(() => {
                this.processOptions = new ProcessOptions(
                    this.binPath,
                    this.getSocketPath(),
                    buildProcessOptions(this.config),
                );

                const agent = new ExternalProcessAgent(this.processOptions, this.log);
                if (!agent) { throw new Errors.NoAgentPresent(); }

                return this.setupAgent(agent);
            })
        // Once we have an agent (this.agent is also set), then start, connect, and register
            .then(() => {
                this.log(`[scout] starting process w/ bin @ path [${this.binPath}]`, LogLevel.Debug);
                this.log(`[scout] process options:\n${JSON.stringify(this.processOptions)}`, LogLevel.Debug);

                if (!this.agent) { throw new Errors.NoAgentPresent(); }

                return this.agent.start();
            })
            .then(() => this.log("[scout] agent successfully started", LogLevel.Debug))
            .then(() => {
                if (!this.agent) { throw new Errors.NoAgentPresent(); }
                return this.agent;
            });
    }

    /**
     * Create an async namespace internally for use with tracking if not already present
     */
    private createAsyncNamespace() {
        this.asyncNamespace = cls.getNamespace(ASYNC_NS);

        // Create if it doesn't exist
        if (!this.asyncNamespace) {
            this.asyncNamespace = cls.createNamespace(ASYNC_NS);
        }
    }

    /**
     * Perform some action within a context
     *
     */
    private withAsyncRequestContext(cb: DoneCallback): Promise<any> {
        return new Promise((resolve) => {
            let result;
            let request: ScoutRequest;
            let ranCb = false;

            // Run in the async namespace
            this.asyncNamespace.run(() => {

                // Make done function that will run after
                const doneFn = () => {
                    // Finish if the request itself is no longer present
                    if (!request) { return Promise.resolve(); }

                    this.log(`[scout] Finishing and sending request with ID [${request.id}]`, LogLevel.Debug);
                    this.clearAsyncNamespaceEntry(ASYNC_NS_REQUEST);
                    this.clearAsyncNamespaceEntry(ASYNC_NS_SPAN);

                    // Finish and send
                    return request.finishAndSend()
                        .then(() => {
                            this.log(`[scout] Finished and sent request [${request.id}]`, LogLevel.Debug);
                        })
                        .catch(err => {
                            this.log(
                                `[scout] Failed to finish and send request [${request.id}]:\n ${err}`,
                                LogLevel.Error,
                            );
                        });

                };

                this.log(`[scout] Starting request in async namespace...`, LogLevel.Debug);

                // Bind the cb to this namespace
                cb = this.asyncNamespace.bind(cb);

                // Start the request
                this.startRequest()
                    .then(r => request = r)
                // Update async namespace, run function
                    .then(() => {
                        this.log(`[scout] Request started w/ ID [${request.id}]`, LogLevel.Debug);
                        this.asyncNamespace.set(ASYNC_NS_REQUEST, request);

                        // Set function to call on finish
                        // NOTE: at least *two* async contexts will be created for each request -- one for the request
                        // and one for every span started inside the request. this.asyncNamespace is almost certain
                        // to be different by the time that stopFn is run -- we need to bind the stopFn to ensure
                        // the right async namespace gets cleared.
                        const stopFn = () => {
                            const result = doneFn();
                            if (request) { request.clearOnStop(); }
                            return result;
                        };
                        request.setOnStop(this.asyncNamespace.bind(stopFn));

                        ranCb = true;
                        result = cb(() => request.stop(), {request});

                        // Ensure that the result is a promise
                        resolve(result);
                    })
                // If an error occurs then run the fn and log
                    .catch(err => {
                        // In the case that an error occurs before the request gets made we can't run doneFn
                        if (!ranCb) {
                            result = request ? cb(() => request.stop(), {request}) : cb(() => undefined, {request});
                        }

                        resolve(result);
                        this.log(`[scout] failed to send start request: ${err}`, LogLevel.Error);
                    });
            });
        });
    }

    /**
     * Start a scout request and return a promise which resolves to the started request
     *
     * @param {ScoutRequestOptions} [options]
     * @returns {Promise<ScoutRequest>} a new scout request
     */
    private startRequest(opts?: ScoutRequestOptions): Promise<ScoutRequest> {
        return new Promise((resolve) => resolve(this.startRequestSync(opts)));
    }

    /**
     * Start a scout request synchronously
     *
     * @param {ScoutRequestOptions} [options]
     * @returns {ScoutRequest} a new scout request
     */
    private startRequestSync(opts?: ScoutRequestOptions): ScoutRequest {
        const request = new ScoutRequest(Object.assign({}, {scoutInstance: this}, opts || {}));
        return request.startSync();
    }

    private buildAppMetadataEvent(): Requests.V1ApplicationEvent {
        return new Requests.V1ApplicationEvent(
            `Pid: ${process.pid}`,
            ApplicationEventType.ScoutMetadata,
            this.applicationMetadata.serialize(),
            {timestamp: new Date()},
        );
    }

    // Helper for sending app metadata
    private sendAppMetadataEvent(): Promise<void> {
        return sendThroughAgent(this, this.buildAppMetadataEvent())
            .then(() => undefined)
            .catch(err => {
                this.log("[scout] failed to send start request request", LogLevel.Error);
            });
    }

    // Send the app registration request to the current agent
    private sendRegistrationRequest(): Promise<void> {
        this.log(`[scout] registering application [${this.config.name || ""}]`, LogLevel.Debug);
        return sendThroughAgent(this, new Requests.V1Register(
            this.config.name || "",
            this.config.key || "",
            APIVersion.V1,
        ))
            .then(() => undefined)
            .catch(err => {
                this.log("[scout] failed to send app registration request", LogLevel.Error);
            });
    }

    // Helper function for setting up an agent to be part of the scout instance
    private setupAgent(agent: ExternalProcessAgent): Promise<ExternalProcessAgent> {
        this.agent = agent;

        // Setup forwarding of all events of the agent through the scout instance
        Object.values(AgentEvent).forEach(evt => {
            if (this.agent) {
                this.agent.on(evt, msg => this.emit(evt, msg));
            }
        });

        return Promise.resolve(this.agent);
    }

    private onUncaughtExceptionListener(err: Error) {
        // Get the current request if available
        const currentRequest = this.getCurrentRequest();
        if (!currentRequest) { return; }

        // Mark the curernt request as errored
        currentRequest.addContext(ScoutContextName.Error, "true");
    }

}

// The functions below are exports for module-level use. They need to be made externally available for
// code in this module but *not* as part of the public API for a Scout instance.

/**
 * Send the StartRequest message to the agent
 *
 * @param {Scout} scout - A scout instance
 * @param {ScoutRequest} req - The original request
 * @returns {Promise<ScoutRequest>} the passed in request
 */
export function sendStartRequest(scout: Scout, req: ScoutRequest): Promise<ScoutRequest> {
    if (req.isIgnored()) {
        scout.log(`[scout] Skipping sending StartRequest for ignored req [${req.id}]`, LogLevel.Warn);
        scout.emit(ScoutEvent.IgnoredRequestProcessingSkipped, req);
        return Promise.resolve(req);
    }

    const startReq = new Requests.V1StartRequest({
        requestId: req.id,
        timestamp: req.getTimestamp(),
    });

    return sendThroughAgent(scout, startReq)
        .then(() => req)
        .catch(err => {
            scout.log(`[scout] failed to send start request request: ${err}`, LogLevel.Error);
            return req;
        });
}

/**
 * Send the StopRequest message to the agent
 *
 * @param {Scout} scout - A scout instance
 * @param {ScoutRequest} req - The original request
 * @returns {Promise<ScoutRequest>} the passed in request
 */
export function sendStopRequest(scout: Scout, req: ScoutRequest): Promise<ScoutRequest> {
    if (req.isIgnored()) {
        scout.log(`[scout] Skipping sending StopRequest for ignored req [${req.id}]`, LogLevel.Warn);
        scout.emit(ScoutEvent.IgnoredRequestProcessingSkipped, req);
        return Promise.resolve(req);
    }

    const stopReq = new Requests.V1FinishRequest(req.id, {timestamp: req.getEndTime()});

    return sendThroughAgent(scout, stopReq)
        .then(() => {
            scout.emit(ScoutEvent.RequestSent, {request: req} as ScoutEventRequestSentData);

            return req;
        })
        .catch(err => {
            scout.log("[scout] failed to send stop request request", LogLevel.Error);
            return req;
        });
}

/**
 * Send the TagRequest message to the agent for a single tag
 *
 * @param {Scout} scout - A scout instance
 * @param {ScoutRequest} req - The original request
 * @param {String} name - The tag name
 * @param {String} value - The tag value
 * @returns {Promise<void>} A promise which resolves when the message has been sent
 */
export function sendTagRequest(
    scout: Scout,
    req: ScoutRequest,
    name: string,
    value: JSONValue | JSONValue[],
): Promise<void> {
    if (req.isIgnored()) {
        scout.log(`[scout] Skipping sending TagRequest for ignored req [${req.id}]`, LogLevel.Warn);
        scout.emit(ScoutEvent.IgnoredRequestProcessingSkipped, req);
        return Promise.resolve();
    }

    const tagReq = new Requests.V1TagRequest(name, value, req.id);

    return sendThroughAgent(scout, tagReq)
        .then(() => undefined)
        .catch(err => {
            scout.log("[scout] failed to send tag request", LogLevel.Error);
        });
}

/**
 * Send the StartSpan message to the agent
 *
 * @param {Scout} scout - A scout instance
 * @param {ScoutSpan} span - The original span
 * @returns {Promise<ScoutSpan>} the passed in span
 */
export function sendStartSpan(scout: Scout, span: ScoutSpan): Promise<ScoutSpan> {
    if (span.isIgnored()) {
        scout.log(
            `[scout] Skipping sending StartSpan for span [${span.id}] of ignored request [${span.requestId}]`,
            LogLevel.Warn,
        );
        scout.emit(ScoutEvent.IgnoredRequestProcessingSkipped, span.requestId);
        return Promise.resolve(span);
    }

    const opts = {
        spanId: span.id,
        parentId: span.parentId,
        timestamp: span.getTimestamp(),
    };

    const startSpanReq = new Requests.V1StartSpan(
        span.operation,
        span.requestId,
        opts,
    );

    return sendThroughAgent(scout, startSpanReq)
        .then(() => span)
        .catch(err => {
            scout.log("[scout] failed to send start span request", LogLevel.Error);
            return span;
        });
}

/**
 * Send the TagSpan message to the agent message to the agent
 *
 * @param {Scout} scout - A scout instance
 * @param {ScoutSpan} span - The original span
 * @param {String} name - The tag name
 * @param {String} value - The tag value
 * @returns {Promise<void>} A promise which resolves when the message has been
 */
export function sendTagSpan(
    scout: Scout,
    span: ScoutSpan,
    name: string,
    value: JSONValue | JSONValue[],
): Promise<void> {
    if (span.isIgnored()) {
        scout.log(
            `[scout] Skipping sending TagSpan for span [${span.id}] of ignored request [${span.requestId}]`,
            LogLevel.Warn,
        );
        scout.emit(ScoutEvent.IgnoredRequestProcessingSkipped, span.requestId);
        return Promise.resolve();
    }

    const tagSpanReq = new Requests.V1TagSpan(
        name,
        value,
        span.id,
        span.requestId,
    );

    return sendThroughAgent(scout, tagSpanReq)
        .then(() => undefined)
        .catch(err => {
            scout.log("[scout] failed to send tag span request", LogLevel.Error);
            return undefined;
        });
}

/**
 * Send the StopSpan message to the agent
 *
 * @param {Scout} scout - A scout instance
 * @param {ScoutSpan} span - The original span
 * @returns {Promise<ScoutSpan>} the passed in request
 */
export function sendStopSpan(scout: Scout, span: ScoutSpan): Promise<ScoutSpan> {
    if (span.isIgnored()) {
        scout.log(
            `[scout] Skipping sending StartSpan for span [${span.id}] of ignored request [${span.requestId}]`,
            LogLevel.Warn,
        );
        scout.emit(ScoutEvent.IgnoredRequestProcessingSkipped, span.requestId);
        return Promise.resolve(span);
    }

    const stopSpanReq = new Requests.V1StopSpan(span.id, span.requestId, {timestamp: span.getEndTime()});

    return sendThroughAgent(scout, stopSpanReq)
        .then(() => span)
        .catch(err => {
            scout.log("[scout] failed to send stop span request", LogLevel.Error);
            return span;
        });
}

/**
 * Helper function for sending a given request through the agent
 *
 * @param {Scout} scout - A scout instance
 * @param {T extends BaseAgentRequest} msg - The message to send
 * @returns {Promise<T extends BaseAgentResponse>} resp - The message to send
 */
export function sendThroughAgent<T extends BaseAgentRequest, R extends BaseAgentResponse>(
    scout: Scout,
    msg: T,
    opts?: {async: boolean},
): Promise<R | void> {
    if (!scout.hasAgent()) {
        const err = new Errors.Disconnected("No agent is present, please run .setup()");
        scout.log(err.message, LogLevel.Error);
        return Promise.reject(err);
    }

    const agent = scout.getAgent();
    const config = scout.getConfig();

    if (!agent) {
        scout.log("[scout] agent is missing, cannot send", LogLevel.Warn);
        return Promise.reject(new Errors.NoAgentPresent());
    }

    if (!config.monitor) {
        scout.log("[scout] monitoring disabled, not sending tag request", LogLevel.Warn);
        return Promise.reject(new Errors.MonitoringDisabled());
    }

    if (opts && opts.async) {
        return agent.sendAsync(msg);
    }

    return agent.send(msg) as Promise<void | R>;
}

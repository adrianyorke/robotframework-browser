import { Browser, BrowserContext, ElementHandle, Page, chromium, firefox, webkit } from 'playwright';
import { ServerUnaryCall, sendUnaryData } from 'grpc';
import { v4 as uuidv4 } from 'uuid';

import { Request, Response } from './generated/playwright_pb';
import { emptyWithLog, intResponse, stringResponse } from './response-util';
import { exists, invokeOnPage } from './playwirght-invoke';

import * as pino from 'pino';

const logger = pino.default({ timestamp: pino.stdTimeFunctions.isoTime });

function lastItem<T>(array: T[]): T | undefined {
    return array[array.length - 1];
}

async function _newBrowser(
    browserType?: string,
    headless?: boolean,
    options?: Record<string, unknown>,
): Promise<[Browser, string]> {
    browserType = browserType || 'chromium';
    headless = headless || true;
    let browser;
    if (browserType === 'firefox') {
        browser = await firefox.launch({ headless: headless, ...options });
    } else if (browserType === 'chromium') {
        browser = await chromium.launch({ headless: headless, ...options });
    } else if (browserType === 'webkit') {
        browser = await webkit.launch({ headless: headless, ...options });
    } else {
        throw new Error('unsupported browser');
    }
    return [browser, browserType];
}

async function _newBrowserContext(
    browser: Browser,
    options?: Record<string, unknown>,
    hideRfBrowser?: boolean,
): Promise<IndexedContext> {
    const context = await browser.newContext(options);
    if (!hideRfBrowser) {
        await context.addInitScript(function () {
            window.__SET_RFBROWSER_STATE__ = function (state: any) {
                window.__RFBROWSER__ = state;
                return state;
            };
        });
    }
    context.setDefaultTimeout(parseFloat(process.env.TIMEOUT || '10000'));
    const id = uuidv4();
    return { id: id, c: context, pageStack: [], options: options };
}

async function _newPage(context: BrowserContext): Promise<IndexedPage> {
    const id = uuidv4();
    const newPage = await context.newPage();
    return { id: id, p: newPage };
}

export class PlaywrightState {
    constructor() {
        this.browserStack = [];
        this.elementHandles = new Map();
    }
    private browserStack: BrowserState[];
    get activeBrowser() {
        return lastItem(this.browserStack);
    }
    elementHandles: Map<string, ElementHandle>;
    public getActiveBrowser = <T>(callback: sendUnaryData<T>): BrowserState => {
        const currentBrowser = this.activeBrowser;
        if (currentBrowser === undefined) {
            const error = new Error('Browser has been closed.');
            callback(error, null);
            throw error;
        } else {
            return currentBrowser;
        }
    };

    public switchTo = <T>(id: Uuid, callback: sendUnaryData<T>): BrowserState => {
        const browser = this.browserStack.find((b) => b.id === id);
        exists(browser, callback, `No browser for id '${id}'`);
        this.browserStack = this.browserStack.filter((b) => b.id !== id);
        this.browserStack.push(browser);
        return this.getActiveBrowser(callback);
    };

    public async getOrCreateActiveBrowser(): Promise<BrowserState> {
        const currentBrowser = this.activeBrowser;
        if (currentBrowser === undefined) {
            const [newBrowser, name] = await _newBrowser();
            const newState = new BrowserState(name, newBrowser);
            this.browserStack.push(newState);
            return newState;
        } else {
            return currentBrowser;
        }
    }

    public async closeAll(): Promise<void> {
        const browsers = this.browserStack;
        for (const b of browsers) {
            await b.close();
        }
        this.browserStack = [];
    }

    public async getCatalog() {
        const pageToContents = async (page: IndexedPage) => {
            return {
                type: 'page',
                title: await page.p.title(),
                url: page.p.url(),
                id: page.id,
            };
        };

        const contextToContents = async (context: IndexedContext) => {
            return {
                type: 'context',
                id: context.id,
                pages: await Promise.all(context.pageStack.map(pageToContents)),
            };
        };

        return Promise.all(
            this.browserStack.map(async (browser) => {
                return {
                    type: browser.name,
                    id: browser.id,
                    contexts: await Promise.all(browser.contextStack.map(contextToContents)),
                    activePage: browser.page?.id,
                    activeContext: browser.context?.id,
                    activeBrowser: this.activeBrowser === browser,
                };
            }),
        );
    }

    public addBrowser(name: string, browser: Browser): BrowserState {
        const browserState = new BrowserState(name, browser);
        browserState.id = uuidv4();
        this.browserStack.push(browserState);
        return browserState;
    }

    public popBrowser(): void {
        this.browserStack.pop();
    }

    public getActiveContext = (): BrowserContext | undefined => {
        return this.activeBrowser?.context?.c;
    };

    public getActivePage = (): Page | undefined => {
        return this.activeBrowser?.page?.p;
    };

    public addElement(id: string, handle: ElementHandle): void {
        this.elementHandles.set(id, handle);
    }

    public getElement(id: string): ElementHandle {
        const elem = this.elementHandles.get(id);
        if (elem) {
            return elem;
        }
        throw new Error(`No element handle found with id \`${id}\`.`);
    }
}

type IndexedContext = {
    c: BrowserContext;
    id: Uuid;
    pageStack: IndexedPage[];
    options?: Record<string, unknown>;
};

type IndexedPage = {
    p: Page;
    id: Uuid;
};

// Meta type to make it clearer where we are handling actual id's
type Uuid = string

export class BrowserState {
    constructor(name: string, browser: Browser) {
        this.name = name;
        this.browser = browser;
        this._contextStack = [];
        this.id = uuidv4();
    }
    private _contextStack: IndexedContext[];
    browser: Browser;
    name?: string;
    id: Uuid;

    public async close(): Promise<void> {
        this.context = undefined;
        this.page = undefined;
        this._contextStack = [];
        await this.browser.close();
    }

    public async getOrCreateActiveContext(): Promise<IndexedContext> {
        if (this.context) {
            return this.context;
        } else {
            const browser = this.browser;
            const context = await _newBrowserContext(browser);
            this.context = context;
            return context;
        }
    }
    get context(): IndexedContext | undefined {
        return lastItem(this._contextStack);
    }
    set context(newContext: IndexedContext | undefined) {
        if (newContext !== undefined) {
            if (newContext.options === undefined) {
                // copy known options
                newContext.options = this._contextStack.find((c) => c.c === newContext.c)?.options;
            }
            // prevent duplicates
            this._contextStack = this._contextStack.filter((c) => c.c !== newContext.c);
            this._contextStack.push(newContext);
            logger.info('Changed active context');
        } else logger.info('Set active context to undefined');
    }
    get page(): IndexedPage | undefined {
        const context = this.context;
        if (context) return lastItem(context.pageStack);
        else return undefined;
    }

    set page(newPage: IndexedPage | undefined) {
        const currentContext = this.context;
        if (newPage !== undefined && currentContext !== undefined) {
            // prevent duplicates
            currentContext.pageStack = currentContext.pageStack.filter((p) => p.p !== newPage.p);
            currentContext.pageStack.push(newPage);
            logger.info('Changed active page');
        } else {
            logger.info('Set active page to undefined');
        }
    }
    get contextStack(): IndexedContext[] {
        return this._contextStack;
    }
    public popPage(): void {
        const pageStack = this.context?.pageStack || [];
        pageStack.pop();
    }
    public popContext(): void {
        this._contextStack.pop();
        const context = lastItem(this._contextStack);
        if (context) {
            this.context = context;
        } else {
            this.context = undefined;
        }
    }
}

export async function closeBrowser(callback: sendUnaryData<Response.Empty>, openBrowsers: PlaywrightState) {
    const id = openBrowsers.activeBrowser;
    const currentBrowser = openBrowsers.activeBrowser;
    if (currentBrowser === undefined) {
        callback(new Error(`Tried to close Browser ${id}, was already closed.`), null);
        return;
    }
    await currentBrowser.close();
    openBrowsers.popBrowser();
    callback(null, emptyWithLog('Closed browser'));
}

export async function closeAllBrowsers(callback: sendUnaryData<Response.Empty>, openBrowsers: PlaywrightState) {
    await openBrowsers.closeAll();
    callback(null, emptyWithLog('Closed all browsers'));
}

export async function closeContext(
    callback: sendUnaryData<Response.Empty>,
    openBrowsers: PlaywrightState,
): Promise<void> {
    const activeBrowser = openBrowsers.getActiveBrowser(callback);
    await openBrowsers.getActiveContext()?.close();
    activeBrowser.popContext();
    callback(null, emptyWithLog('Succesfully closed Context'));
}

export async function closePage(callback: sendUnaryData<Response.Empty>, openBrowsers: PlaywrightState): Promise<void> {
    const activeBrowser = openBrowsers.getActiveBrowser(callback);
    await openBrowsers.getActivePage()?.close();
    activeBrowser.popPage();
    callback(null, emptyWithLog('Succesfully closed Page'));
}

export async function newPage(
    call: ServerUnaryCall<Request.Url>,
    callback: sendUnaryData<Response.String>,
    openBrowsers: PlaywrightState,
): Promise<void> {
    const browserState = await openBrowsers.getOrCreateActiveBrowser();
    const context = await browserState.getOrCreateActiveContext();

    const page = await _newPage(context.c);
    browserState.page = page;
    const url = call.request.getUrl() || 'about:blank';
    await invokeOnPage(page.p, callback, 'goto', url, { timeout: 10000 });
    const response = stringResponse(page.id, 'New page opeened.');
    response.setLog('Succesfully initialized new page object and opened url: ' + url);
    callback(null, response);
}

export async function newContext(
    call: ServerUnaryCall<Request.Context>,
    callback: sendUnaryData<Response.String>,
    openBrowsers: PlaywrightState,
): Promise<void> {
    const hideRfBrowser = call.request.getHiderfbrowser();
    const browserState = await openBrowsers.getOrCreateActiveBrowser();
    try {
        const options = JSON.parse(call.request.getRawoptions());
        const context = await _newBrowserContext(browserState.browser, options, hideRfBrowser);
        browserState.context = context;

        const response = stringResponse(context.id, 'New context opened');
        response.setLog('Succesfully created context with options: ' + JSON.stringify(options));
        callback(null, response);
    } catch (error) {
        callback(error, null);
        return;
    }
}

export async function newBrowser(
    call: ServerUnaryCall<Request.Browser>,
    callback: sendUnaryData<Response.String>,
    openBrowsers: PlaywrightState,
): Promise<void> {
    const browserType = call.request.getBrowser();
    const headless = call.request.getHeadless();

    try {
        const options = JSON.parse(call.request.getRawoptions());
        const [browser, name] = await _newBrowser(browserType, headless, options);
        const browserState = openBrowsers.addBrowser(name, browser);
        const response = stringResponse(browserState.id, 'New browser opened, with options: ' + options);
        callback(null, response);
    } catch (error) {
        callback(error, null);
    }
}

export async function autoActivatePages(
    call: ServerUnaryCall<Request.Empty>,
    callback: sendUnaryData<Response.Empty>,
    browserState?: BrowserState,
) {
    exists(
        browserState?.context?.c,
        callback,
        'Tried to focus next opened page, no context was open in current Browser',
    );

    browserState.context.c.on('page', (page) => {
        exists(
            browserState?.context?.c,
            callback,
            `Tried to focus on new page in context, context didn't exist! This should be impossible.`,
        );
        const pageIndex = uuidv4();
        browserState.context.pageStack.push({ p: page, id: pageIndex });
        logger.info('Changed active page');
    });
    callback(null, emptyWithLog('Will focus future ``pages`` in this context'));
}

async function _switchPage(id: string, browserState: BrowserState, waitForPage: boolean) {
    const context = browserState.context;
    if (!context) throw new Error('Tried to switch page, no open context');
    const pages = context.pageStack;

    const page = pages.find(p => p.id == id)
    if (page) {
        browserState.page = { id: id, p: page.p };
        await page.p.bringToFront();
        return;
    } else if (waitForPage) {
        try {
            logger.info('Started waiting for a page to pop up');
            const page = await context.c.waitForEvent('page');
            browserState.page = { id: id, p: page };
            await page.bringToFront();
            return;
        } catch (pwError) {
            logger.info('Wait was not fulfilled');
            logger.error(pwError);
            const mapped = pages?.map((page) => page.p.url()).join(',');
            const message = `No page for id ${id}. Open pages: ${mapped}`;
            const error = new Error(message);
            throw error;
        }
    } else {
        throw new Error(`Couldn't switch page`);
    }
}

async function _switchContext(id: string, browserState: BrowserState) {
    const contexts = browserState.contextStack;
    const context = contexts.find(context => context.id == id)
    if (contexts && context) {
        browserState.context = context;
        return;
    } else {
        const mapped = contexts
            ?.map((c) => c.pages())
            .reduce((acc, val) => acc.concat(val), [])
            .map((p) => p.url());

        const message = `No context for id ${id}. Open contexts: ${mapped}`;
        throw new Error(message);
    }
}

export async function switchPage(
    call: ServerUnaryCall<Request.Index>,
    callback: sendUnaryData<Response.String>,
    browserState?: BrowserState,
) {
    exists(browserState, callback, "Tried to switch Page but browser wasn't open");
    logger.info('Changing current active page');
    const id = call.request.getIndex();
    const previous = browserState.page?.id || 0;
    await _switchPage(id, browserState, true).catch((error) => callback(error, null));
    const response = stringResponse(previous, 'Succesfully changed active page');
    callback(null, response);
}

export async function switchContext(
    call: ServerUnaryCall<Request.Index>,
    callback: sendUnaryData<Response.String>,
    browserState: BrowserState,
): Promise<void> {
    const id = call.request.getIndex();
    const previous = browserState.context?.id || 0;

    await _switchContext(id, browserState).catch((error) => callback(error, null));
    await _switchPage(browserState.page?.id || 0, browserState, false).catch((error) => {
        logger.error(error);
    });
    const response = stringResponse(previous, 'Succesfully changed active context');
    callback(null, response);
}

export async function switchBrowser(
    call: ServerUnaryCall<Request.Index>,
    callback: sendUnaryData<Response.String>,
    openBrowsers: PlaywrightState,
): Promise<void> {
    const id = call.request.getIndex();
    const previous = openBrowsers.activeBrowser;
    openBrowsers.switchTo(id, callback);
    const response = stringResponse(previous?.id || -1, 'Succesfully changed active browser');
    callback(null, response);
}

export async function getBrowserCatalog(
    callback: sendUnaryData<Response.String>,
    openBrowsers: PlaywrightState,
): Promise<void> {
    const response = new Response.String();
    response.setBody(JSON.stringify(await openBrowsers.getCatalog()));
    callback(null, response);
}

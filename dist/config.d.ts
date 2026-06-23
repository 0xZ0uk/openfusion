import "dotenv/config";
declare function loadConfig(): {
    litellm: {
        baseUrl: string;
        apiKey: string;
    };
    server: {
        host: string;
        port: number;
        apiKey: string | undefined;
    };
    defaults: {
        panel: string[];
        judge: string;
        outerModel: string;
    };
    search: {
        braveApiKey: string | undefined;
        enabled: boolean;
    };
};
export type Config = ReturnType<typeof loadConfig>;
export declare const config: {
    litellm: {
        baseUrl: string;
        apiKey: string;
    };
    server: {
        host: string;
        port: number;
        apiKey: string | undefined;
    };
    defaults: {
        panel: string[];
        judge: string;
        outerModel: string;
    };
    search: {
        braveApiKey: string | undefined;
        enabled: boolean;
    };
};
export {};
//# sourceMappingURL=config.d.ts.map
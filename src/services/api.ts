import axios from 'axios';

export default class ApiClient {
    public baseUrl: string;
    public timeout: number;

    constructor(url: string) {
        this.baseUrl = url;
        this.timeout = 600000; // 10 minutes
    }

    private getHeaders(token?: string) {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (token) {
            headers['Authorization'] = token;
        }
        return headers;
    }

    protected async get<T>(endpoint: string, params: Record<string, any> = {}, token?: string): Promise<T> {
        const response = await axios.get(`${this.baseUrl}/${endpoint}`, {
            headers: this.getHeaders(token),
            params,
            timeout: this.timeout,
        });
        return response.data;
    }

    protected async post<T>(endpoint: string, data: Record<string, any>, token?: string): Promise<T> {
        const response = await axios.post(`${this.baseUrl}/${endpoint}`, data, {
            headers: this.getHeaders(token),
            timeout: this.timeout,
        });
        return response.data;
    }
}

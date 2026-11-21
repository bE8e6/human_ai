import BuildProfile from 'BuildProfile';

export class AppConfig {
  static readonly development: boolean = BuildProfile.DEBUG;
  static readonly version: string = BuildProfile.VERSION_NAME;
  static readonly serviceUrl: string = BuildProfile.SERVICE_URL;
  static defaultBase(): string { return AppConfig.development ? 'http://127.0.0.1:8787' : AppConfig.serviceUrl; }
}

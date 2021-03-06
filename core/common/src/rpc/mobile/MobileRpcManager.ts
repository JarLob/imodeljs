/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
import { RpcInterfaceDefinition } from "../../RpcInterface";
import { RpcConfiguration } from "../core/RpcConfiguration";
import { RpcEndpoint, RpcMobilePlatform } from "../core/RpcConstants";
import { interop, MobileRpcProtocol } from "./MobileRpcProtocol";

/** Holds configuration for the RpcInterfaces used by the application.
 * @beta
 */
export abstract class MobileRpcConfiguration extends RpcConfiguration {
  public abstract protocol: MobileRpcProtocol;
  private static getMobilePlatform(): RpcMobilePlatform {
    if (typeof window === "undefined") {
      return RpcMobilePlatform.Unknown;
    }

    const win: any = window;
    const userAgent = win.navigator.userAgent || win.navigator.vendor || win.opera;

    if (/android/i.test(userAgent)) {
      return RpcMobilePlatform.Android;
    }

    if (/iPad|iPhone|iPod/.test(userAgent) && !win.MSStream) {
      return RpcMobilePlatform.iOS;
    }

    return RpcMobilePlatform.Unknown;
  }

  /** Return type of mobile platform using browser userAgent */
  public static readonly platform: RpcMobilePlatform = MobileRpcConfiguration.getMobilePlatform();

  /** Check if running backend running on mobile */
  public static get isMobileBackend() { return interop !== null; }

  /** Check if running backend running on mobile */
  public static get isMobileFrontend() { return MobileRpcConfiguration.platform !== RpcMobilePlatform.Unknown; }

  /** Check if running backend running on wkwebview on ios */
  public static get isIOSFrontend() { return MobileRpcConfiguration.isMobileFrontend && (window as any).webkit && (window as any).webkit.messageHandlers; }
}

/** Coordinates usage of RPC interfaces for an Mobile-based application.
 * @beta
 */
export class MobileRpcManager {
  private static performInitialization(interfaces: RpcInterfaceDefinition[], endPoint: RpcEndpoint): MobileRpcConfiguration {
    const config = class extends MobileRpcConfiguration {
      public interfaces = () => interfaces;
      public protocol: MobileRpcProtocol = new MobileRpcProtocol(this, endPoint);
    };

    for (const def of interfaces) {
      RpcConfiguration.assign(def, () => config);
    }

    const instance = RpcConfiguration.obtain(config);
    RpcConfiguration.initializeInterfaces(instance);

    return instance;
  }

  /** Initializes MobileRpcManager for the frontend of an application. */
  public static initializeClient(interfaces: RpcInterfaceDefinition[]): MobileRpcConfiguration {
    return MobileRpcManager.performInitialization(interfaces, RpcEndpoint.Frontend);
  }
  /** Initializes MobileRpcManager for the backend of an application. */
  public static initializeImpl(interfaces: RpcInterfaceDefinition[]): MobileRpcConfiguration {
    return MobileRpcManager.performInitialization(interfaces, RpcEndpoint.Backend);
  }
}

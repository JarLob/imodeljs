/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
/** @module Core */

export { default as PersistenceHelper } from "./PersistenceHelper";
export { default as Presentation } from "./Presentation";
export { default as PresentationManager } from "./PresentationManager";
export { default as RulesetVariablesManager } from "./RulesetVariablesManager";

/** @module UnifiedSelection */
export { default as SelectionChangeEvent, SelectionChangeEventArgs, SelectionChangeType, SelectionChangesListener } from "./selection/SelectionChangeEvent";
export { default as ISelectionProvider } from "./selection/ISelectionProvider";
export { SelectionManager } from "./selection/SelectionManager";
export { default as SelectionHandler } from "./selection/SelectionHandler";

// Set the version number so it can be found at runtime. BUILD_SEMVER is replaced at build time by the webpack DefinePlugin.
declare var BUILD_SEMVER: string;
/* istanbul ignore next */
if ((typeof (BUILD_SEMVER) !== "undefined") && (typeof window !== "undefined") && window) {
  if (!(window as any).iModelJsVersions)
    (window as any).iModelJsVersions = new Map<string, string>();
  (window as any).iModelJsVersions.set("presentation-frontend", BUILD_SEMVER);
}

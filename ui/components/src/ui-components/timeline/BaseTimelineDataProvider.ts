/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
/** @module Timeline */

import { ScreenViewport } from "@bentley/imodeljs-frontend";
import {
  TimelineDataProvider,
  Milestone, PlaybackSettings,
} from "./interfaces";

/** Base Timeline Data Provider
 * @alpha
 */
export class BaseTimelineDataProvider implements TimelineDataProvider {
  public readonly id = "TestTimelineDataProvider";
  public start: Date | undefined;
  public end: Date | undefined;
  public supportsTimelineAnimation = false; // set to true when provider determines animation data is available.
  public animationFraction: number = 0; // value from 0.0 to 1.0 that specifies the percentage complete for the animation.
  protected _milestones: Milestone[] = [];
  protected _viewport: ScreenViewport | undefined;

  constructor(viewport?: ScreenViewport) {
    this._viewport = viewport;
  }

  protected _settings: PlaybackSettings = {
    duration: 20 * 1000,
    loop: true,
  };

  // istanbul ignore next
  public async loadTimelineData(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** Called to get the initial scrubber location */
  public get initialDuration(): number {
    return this.duration * this.animationFraction;
  }

  /** Called to get playback duration  */
  public get duration(): number {
    return (this.getSettings().duration) ? this.getSettings().duration! : 20000;
  }

  public set viewport(viewport: ScreenViewport | undefined) {
    this._viewport = viewport;
  }

  public get viewport(): ScreenViewport | undefined {
    return this._viewport;
  }

  public get loop(): boolean {
    return (undefined === this.getSettings().loop) ? false : this.getSettings().loop!;
  }

  public getMilestonesCount(parent?: Milestone): number {
    if (undefined === parent)
      return this._milestones.length;

    if (undefined === parent.children)
      return 0;

    return parent.children.length;
  }

  private findMilestone(milestoneId: string, milestones: Milestone[]): Milestone | undefined {
    if (milestones.length <= 0)
      return undefined;

    let milestone = milestones.find((value) => value.id.toLowerCase() === milestoneId);
    if (milestone)
      return milestone;

    // tslint:disable-next-line:prefer-for-of
    for (let i = 0; i < milestones.length; i++) {
      if (milestones[i].children) {
        milestone = this.findMilestone(milestoneId, milestones[i].children!);
        if (milestone)
          return milestone;
      }
    }
    return undefined;
  }

  public findMilestoneById(milestoneId: string, milestones?: Milestone[]): Milestone | undefined {
    if (undefined === milestones)
      milestones = this._milestones;

    return this.findMilestone(milestoneId.toLowerCase(), milestones);
  }

  public getMilestones(parent?: Milestone): Milestone[] {
    if (undefined === parent) {
      return this._milestones;
    }

    if (parent && parent.children)
      return parent.children!;

    return [];
  }

  public getSettings(): PlaybackSettings {
    return this._settings;
  }

  public updateSettings(settings: PlaybackSettings) {
    this._settings = { ...this._settings, ...settings };
  }

  // istanbul ignore next
  public onPlaybackSettingChanged = (_settings: PlaybackSettings) => {
  }

  // istanbul ignore next
  public onAnimationFractionChanged = (_animationFraction: number) => {
  }
}

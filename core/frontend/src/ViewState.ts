/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
/** @module Views */

import { assert, Id64, Id64String, JsonUtils, BeTimePoint } from "@bentley/bentleyjs-core";
import {
  Angle, AxisOrder, ClipVector, Constant, Geometry, LowAndHighXY, LowAndHighXYZ, Map4d, Matrix3d, Plane3dByOriginAndUnitNormal,
  Point2d, Point3d, PolyfaceBuilder, Range3d, Ray3d, StrokeOptions, Transform, Vector2d, Vector3d, XAndY, XYAndZ, YawPitchRollAngles,
} from "@bentley/geometry-core";
import {
  AnalysisStyle, AxisAlignedBox3d, Camera, ColorDef, Frustum, GraphicParams, Npc, RenderMaterial, SpatialViewDefinitionProps,
  SubCategoryOverride, TextureMapping, ViewDefinition2dProps, ViewDefinition3dProps, ViewDefinitionProps,
  ViewFlags, ViewStateProps,
} from "@bentley/imodeljs-common";
import { AuxCoordSystem2dState, AuxCoordSystem3dState, AuxCoordSystemSpatialState, AuxCoordSystemState } from "./AuxCoordSys";
import { CategorySelectorState } from "./CategorySelectorState";
import { DisplayStyle2dState, DisplayStyle3dState, DisplayStyleState } from "./DisplayStyleState";
import { ElementState } from "./EntityState";
import { IModelApp } from "./IModelApp";
import { IModelConnection } from "./IModelConnection";
import { ModelSelectorState } from "./ModelSelectorState";
import { GeometricModel2dState, GeometricModelState, TileTreeModelState } from "./ModelState";
import { NotifyMessageDetails, OutputMessagePriority } from "./NotificationManager";
import { GraphicType } from "./render/GraphicBuilder";
import { RenderScheduleState } from "./RenderScheduleState";
import { StandardView, StandardViewId } from "./StandardView";
import { TileTree } from "./tile/TileTree";
import { DecorateContext, SceneContext } from "./ViewContext";
import { Viewport, ViewFrustum } from "./Viewport";
import { SpatialClassification } from "./SpatialClassification";

/** Describes the orientation of the grid displayed within a [[Viewport]].
 * @public
 */
export enum GridOrientationType {
  /** Oriented with the view. */
  View = 0,
  /** Top */
  WorldXY = 1,
  /** Right */
  WorldYZ = 2,
  /** Front */
  WorldXZ = 3,
  /** Oriented by the [[AuxCoordSystem]] */
  AuxCoord = 4,
}

/** Describes the result of a viewing operation such as those exposed by [[ViewState]] and [[Viewport]].
 * @public
 */
export enum ViewStatus {
  Success = 0,
  ViewNotInitialized,
  AlreadyAttached,
  NotAttached,
  DrawFailure,
  NotResized,
  ModelNotFound,
  InvalidWindow,
  MinWindow,
  MaxWindow,
  MaxZoom,
  MaxDisplayDepth,
  InvalidUpVector,
  InvalidTargetPoint,
  InvalidLens,
  InvalidViewport,
}

/** Margins for white space to be left around view volumes for [[ViewState.lookAtVolume]].
 * Values mean "fraction of view size" and must be between 0 and .25.
 * @public
 */
export class MarginPercent {
  constructor(public left: number, public top: number, public right: number, public bottom: number) {
    const limitMargin = (val: number) => Geometry.clamp(val, 0.0, 0.25);
    this.left = limitMargin(left);
    this.top = limitMargin(top);
    this.right = limitMargin(right);
    this.bottom = limitMargin(bottom);
  }
}

/** Describes the largest and smallest values allowed for the extents of a [[ViewState]].
 * Attempts to exceed these limits in any dimension will fail, preserving the previous extents.
 * @public
 */
export interface ExtentLimits {
  /** The smallest allowed extent in any dimension. */
  min: number;
  /** The largest allowed extent in any dimension. */
  max: number;
}

/** @internal */
export abstract class ViewStateUndo {
  public undoTime?: BeTimePoint;
  public abstract equalState(view: ViewState): boolean;
}

/** @internal */
class ViewState3dUndo extends ViewStateUndo {
  public readonly cameraOn: boolean;
  public readonly origin: Point3d;
  public readonly extents: Vector3d;
  public readonly rotation: Matrix3d;
  public readonly camera: Camera;

  public constructor(view: ViewState3d) {
    super();
    this.cameraOn = view.isCameraOn;
    this.origin = view.origin.clone();
    this.extents = view.extents.clone();
    this.rotation = view.rotation.clone();
    this.camera = view.camera.clone();
  }

  public equalState(view: ViewState3d): boolean {
    return this.cameraOn === view.isCameraOn &&
      this.origin.isAlmostEqual(view.origin) &&
      this.extents.isAlmostEqual(view.extents) &&
      this.rotation.isAlmostEqual(view.rotation) &&
      (!this.cameraOn || this.camera.equals(view.camera)); // ###TODO: should this be less precise equality?
  }
}

/** @internal */
class ViewState2dUndo extends ViewStateUndo {
  public readonly origin: Point2d;
  public readonly delta: Point2d;
  public readonly angle: Angle;
  public constructor(view: ViewState2d) {
    super();
    this.origin = view.origin.clone();
    this.delta = view.delta.clone();
    this.angle = view.angle.clone();
  }

  public equalState(view: ViewState2d): boolean {
    return this.origin.isAlmostEqual(view.origin) &&
      this.delta.isAlmostEqual(view.delta) &&
      this.angle.isAlmostEqualNoPeriodShift(view.angle);
  }
}

/** The front-end state of a [[ViewDefinition]] element.
 * A ViewState is typically associated with a [[Viewport]] to display the contents of the view on the screen.
 * * @see [Views]($docs/learning/frontend/Views.md)
 * @public
 */
export abstract class ViewState extends ElementState {
  /** The name of the associated ECClass */
  public static get className() { return "ViewDefinition"; }

  private _auxCoordSystem?: AuxCoordSystemState;
  private _extentLimits?: ExtentLimits;
  private _clipVector?: ClipVector;
  public description?: string;
  public isPrivate?: boolean;
  /** Selects the categories that are display by this ViewState. */
  public categorySelector: CategorySelectorState;
  /** Selects the styling parameters for this this ViewState. */
  public displayStyle: DisplayStyleState;

  /** @internal */
  protected constructor(props: ViewDefinitionProps, iModel: IModelConnection, categoryOrClone: CategorySelectorState, displayStyle: DisplayStyleState) {
    super(props, iModel);
    this.description = props.description;
    this.isPrivate = props.isPrivate;
    this.displayStyle = displayStyle;
    this.categorySelector = categoryOrClone;
    if (!(categoryOrClone instanceof ViewState))  // is this from the clone method?
      return; // not from clone

    // from clone, 3rd argument is source ViewState
    const source = categoryOrClone as ViewState;
    this.categorySelector = source.categorySelector.clone();
    this.displayStyle = source.displayStyle.clone();
    this._extentLimits = source._extentLimits;
    this._auxCoordSystem = source._auxCoordSystem;
    this._clipVector = source._clipVector;
  }

  /** Create a new ViewState object from a set of properties. Generally this is called internally by [[IModelConnection.Views.load]] after the properties
   * have been read from an iModel. But, it can also be used to create a ViewState in memory, from scratch or from properties stored elsewhere.
   */
  public static createFromProps(_props: ViewStateProps, _iModel: IModelConnection): ViewState | undefined { return undefined; }

  /** Get the ViewFlags from the [[DisplayStyleState]] of this ViewState.
   * @note Do not modify this object directly. Instead, use the setter as follows:
   *
   *  ```ts
   *  const flags = viewState.viewFlags.clone();
   *  flags.renderMode = RenderMode.SmoothShade; // or whatever alterations are desired
   *  viewState.viewFlags = flags;
   *  ```ts
   */
  public get viewFlags(): ViewFlags { return this.displayStyle.viewFlags; }
  /** Get the AnalysisDisplayProperties from the displayStyle of this ViewState. */
  public get analysisStyle(): AnalysisStyle | undefined { return this.displayStyle.analysisStyle; }

  /** Get the RenderSchedule.Script from the displayStyle of this viewState */
  public get scheduleScript(): RenderScheduleState.Script | undefined { return this.displayStyle.scheduleScript; }

  /** Determine whether this ViewState exactly matches another. */
  public equals(other: this): boolean { return super.equals(other) && this.categorySelector.equals(other.categorySelector) && this.displayStyle.equals(other.displayStyle); }

  public toJSON(): ViewDefinitionProps {
    const json = super.toJSON() as ViewDefinitionProps;
    json.categorySelectorId = this.categorySelector.id;
    json.displayStyleId = this.displayStyle.id;
    json.isPrivate = this.isPrivate;
    json.description = this.description;
    return json;
  }

  /** Asynchronously load any required data for this ViewState from the backend.
   * @note callers should await the Promise returned by this method before using this ViewState.
   * @see [Views]($docs/learning/frontend/Views.md)
   */
  public async load(): Promise<void> {
    this._auxCoordSystem = undefined;
    const acsId = this.getAuxiliaryCoordinateSystemId();
    if (Id64.isValid(acsId)) {
      const props = await this.iModel.elements.getProps(acsId);
      this._auxCoordSystem = AuxCoordSystemState.fromProps(props[0], this.iModel);
    }

    const subcategories = this.iModel.subcategories.load(this.categorySelector.categories);
    if (undefined !== subcategories)
      await subcategories.promise;

    return Promise.resolve();
  }

  /** @internal */
  public get areAllTileTreesLoaded(): boolean {
    let allLoaded = true;
    this.forEachTileTreeModel((model) => {
      // Loaded or NotFound qualify as "loaded" - either the load succeeded or failed.
      if (model.loadStatus < TileTree.LoadStatus.Loaded)
        allLoaded = false;
    });
    return allLoaded;
  }

  /** Get the name of the [[ViewDefinition]] from which this ViewState originated. */
  public get name(): string { return this.code.getValue(); }

  /** Get this view's background color. */
  public get backgroundColor(): ColorDef { return this.displayStyle.backgroundColor; }

  /** Query the symbology overrides applied to geometry belonging to a specific subcategory when rendered using this ViewState.
   * @param id The Id of the subcategory.
   * @return The symbology overrides applied to all geometry belonging to the specified subcategory, or undefined if no such overrides exist.
   */
  public getSubCategoryOverride(id: Id64String): SubCategoryOverride | undefined {
    return this.displayStyle.getSubCategoryOverride(id);
  }

  /** @internal */
  public isSubCategoryVisible(id: Id64String): boolean {
    const app = this.iModel.subcategories.getSubCategoryAppearance(id);
    if (undefined === app)
      return false;

    const ovr = this.getSubCategoryOverride(id);
    if (undefined === ovr || undefined === ovr.invisible)
      return !app.invisible;
    else
      return !ovr.invisible;
  }

  /** Returns true if this ViewState is-a [[ViewState3d]] */
  public is3d(): this is ViewState3d { return this instanceof ViewState3d; }
  /** Returns true if this ViewState is-a [[ViewState2d]] */
  public is2d(): this is ViewState2d { return this instanceof ViewState2d; }
  /** Returns true if this ViewState is-a [[SpatialViewState]] */
  public isSpatialView(): this is SpatialViewState { return this instanceof SpatialViewState; }
  /** Returns true if [[ViewTool]]s are allowed to operate in three dimensions on this view. */
  public abstract allow3dManipulations(): boolean;
  /** @internal */
  public abstract createAuxCoordSystem(acsName: string): AuxCoordSystemState;
  /** Get the extents of this view in [[CoordSystem.World]] coordinates. */
  public abstract getViewedExtents(): AxisAlignedBox3d;
  /** Compute a range in [[CoordSystem.World]] coordinates that tightly encloses the contents of this view.
   * @see [[FitViewTool]].
   */
  public abstract computeFitRange(): Range3d;

  /** Override this if you want to perform some logic on each iteration of the render loop.
   * @internal
   */
  public abstract onRenderFrame(_viewport: Viewport): void;

  /** Returns true if this view displays the contents of a [[Model]] specified by Id. */
  public abstract viewsModel(modelId: Id64String): boolean;

  /** Get the origin of this view in [[CoordSystem.World]] coordinates. */
  public abstract getOrigin(): Point3d;

  /** Get the extents of this view in [[CoordSystem.World]] coordinates. */
  public abstract getExtents(): Vector3d;

  /** Get the 3x3 ortho-normal Matrix3d for this view. */
  public abstract getRotation(): Matrix3d;

  /** Set the origin of this view in [[CoordSystem.World]] coordinates. */
  public abstract setOrigin(viewOrg: Point3d): void;

  /** Set the extents of this view in [[CoordSystem.World]] coordinates. */
  public abstract setExtents(viewDelta: Vector3d): void;

  /** Change the rotation of the view.
   * @note viewRot must be ortho-normal. For 2d views, only the rotation angle about the z axis is used.
   */
  public abstract setRotation(viewRot: Matrix3d): void;

  /** Execute a function on each viewed model */
  public abstract forEachModel(func: (model: GeometricModelState) => void): void;

  /** @internal */
  public abstract saveForUndo(): ViewStateUndo;

  /** @internal */
  public abstract setFromUndo(props: ViewStateUndo): void;

  /** Execute a function on each viewed model
   * @alpha
   */
  public forEachTileTreeModel(func: (model: TileTreeModelState) => void): void { this.forEachModel((model: GeometricModelState) => func(model)); }
  /** @internal */
  public createScene(context: SceneContext): void {
    this.forEachTileTreeModel((model: TileTreeModelState) => this.addModelToScene(model, context));
  }

  /** @internal */
  public createTerrain(context: SceneContext): void {
    if (undefined !== this.displayStyle.backgroundMapPlane)
      this.displayStyle.backgroundMap.addToScene(context);
  }

  /** @internal */
  public createClassification(context: SceneContext): void {
    this.forEachTileTreeModel((model: TileTreeModelState) => SpatialClassification.addModelClassifierToScene(model, context));
  }

  /** @internal */
  public createSolarShadowMap(_context: SceneContext): void { }

  /** Add view-specific decorations. The base implementation draws the grid. Subclasses must invoke super.decorate()
   * @internal
   */
  public decorate(context: DecorateContext): void {
    this.drawGrid(context);
    if (undefined !== this.displayStyle.backgroundMapPlane)
      this.displayStyle.backgroundMap.decorate(context);
  }

  /** @internal */
  public static getStandardViewMatrix(id: StandardViewId): Matrix3d { return StandardView.getStandardRotation(id); }

  /** Orient this view to one of the [[StandardView]] rotations. */
  public setStandardRotation(id: StandardViewId) { this.setRotation(ViewState.getStandardViewMatrix(id)); }

  /** Get the target point of the view. If there is no camera, center is returned. */
  public getTargetPoint(result?: Point3d): Point3d { return this.getCenter(result); }

  /**  Get the point at the geometric center of the view. */
  public getCenter(result?: Point3d): Point3d {
    const delta = this.getRotation().transpose().multiplyVector(this.getExtents());
    return this.getOrigin().plusScaled(delta, 0.5, result);
  }

  /** @internal */
  public drawGrid(context: DecorateContext): void {
    const vp = context.viewport;
    if (!vp.isGridOn)
      return;

    const orientation = this.getGridOrientation();
    if (GridOrientationType.AuxCoord < orientation) {
      return; // NEEDSWORK...
    }
    if (GridOrientationType.AuxCoord === orientation) {
      this.auxiliaryCoordinateSystem.drawGrid(context);
      return;
    }

    const isoGrid = false;
    const gridsPerRef = this.getGridsPerRef();
    const spacing = Point2d.createFrom(this.getGridSpacing());
    const origin = Point3d.create();
    const matrix = Matrix3d.createIdentity();
    const fixedRepsAuto = Point2d.create();

    this.getGridSettings(vp, origin, matrix, orientation);
    context.drawStandardGrid(origin, matrix, spacing, gridsPerRef, isoGrid, orientation !== GridOrientationType.View ? fixedRepsAuto : undefined);
  }

  /** @internal */
  public computeWorldToNpc(viewRot?: Matrix3d, inOrigin?: Point3d, delta?: Vector3d): { map: Map4d | undefined, frustFraction: number } {
    if (viewRot === undefined) viewRot = this.getRotation();
    const xVector = viewRot.rowX();
    const yVector = viewRot.rowY();
    const zVector = viewRot.rowZ();

    if (delta === undefined) delta = this.getExtents();
    if (inOrigin === undefined) inOrigin = this.getOrigin();

    let frustFraction = 1.0;
    let xExtent: Vector3d;
    let yExtent: Vector3d;
    let zExtent: Vector3d;
    let origin: Point3d;

    // Compute root vectors along edges of view frustum.
    if (this.is3d() && this.isCameraOn) {
      const camera = this.camera;
      const eyeToOrigin = Vector3d.createStartEnd(camera.eye, inOrigin); // vector from origin on backplane to eye
      viewRot.multiplyVectorInPlace(eyeToOrigin);                        // align with view coordinates.

      const focusDistance = camera.focusDist;
      let zDelta = delta.z;
      let zBack = eyeToOrigin.z;              // Distance from eye to backplane.
      let zFront = zBack + zDelta;            // Distance from eye to frontplane.

      if (zFront / zBack < Viewport.nearScale24) {
        // In this case we are running up against the zBuffer resolution limitation (currently 24 bits).
        // Set back clipping plane at 10 kilometer which gives us a front clipping plane about 3 meters.
        // Decreasing the maximumBackClip (MicroStation uses 1 kilometer) will reduce the minimum front
        // clip, but also reduce the back clip (so far geometry may not be visible).
        const maximumBackClip = 10 * Constant.oneKilometer;
        if (-zBack > maximumBackClip) {
          zBack = -maximumBackClip;
          eyeToOrigin.z = zBack;
        }

        zFront = zBack * Viewport.nearScale24;
        zDelta = zFront - eyeToOrigin.z;
      }

      // z out back of eye ===> origin z coordinates are negative.  (Back plane more negative than front plane)
      const backFraction = -zBack / focusDistance;    // Perspective fraction at back clip plane.
      const frontFraction = -zFront / focusDistance;  // Perspective fraction at front clip plane.
      frustFraction = frontFraction / backFraction;

      // delta.x,delta.y are view rectangle sizes at focus distance.  Scale to back plane:
      xExtent = xVector.scale(delta.x * backFraction);   // xExtent at back == delta.x * backFraction.
      yExtent = yVector.scale(delta.y * backFraction);   // yExtent at back == delta.y * backFraction.

      // Calculate the zExtent in the View coordinate system.
      zExtent = new Vector3d(eyeToOrigin.x * (frontFraction - backFraction), eyeToOrigin.y * (frontFraction - backFraction), zDelta);
      viewRot.multiplyTransposeVectorInPlace(zExtent);   // rotate back to root coordinates.

      origin = new Point3d(
        eyeToOrigin.x * backFraction,   // Calculate origin in eye coordinates
        eyeToOrigin.y * backFraction,
        eyeToOrigin.z);

      viewRot.multiplyTransposeVectorInPlace(origin);  // Rotate back to root coordinates
      origin.plus(camera.eye, origin); // Add the eye point.
    } else {
      origin = inOrigin;
      xExtent = xVector.scale(delta.x);
      yExtent = yVector.scale(delta.y);
      zExtent = zVector.scale(delta.z);
    }

    // calculate the root-to-npc mapping (using expanded frustum)
    return { map: Map4d.createVectorFrustum(origin, xExtent, yExtent, zExtent, frustFraction), frustFraction };
  }

  /** Calculate the world coordinate Frustum from the parameters of this ViewState.
   * @param result Optional Frustum to hold result. If undefined a new Frustum is created.
   * @returns The 8-point Frustum with the corners of this ViewState, or undefined if the parameters are invalid.
   */
  public calculateFrustum(result?: Frustum): Frustum | undefined {
    const val = this.computeWorldToNpc();
    if (undefined === val.map)
      return undefined;

    const box = result ? result.initNpc() : new Frustum();
    val.map.transform1.multiplyPoint3dArrayQuietNormalize(box.points);
    return box;
  }

  /** Initialize the origin, extents, and rotation from an existing Frustum
   * This function is commonly used in the implementation of [[ViewTool]]s as follows:
   *  1. Obtain the ViewState's initial frustum.
   *  2. Modify the frustum based on user input.
   *  3. Update the ViewState to match the modified frustum.
   * @param frustum the input Frustum.
   * @return Success if the frustum was successfully updated, or an appropriate error code.
   */
  public setupFromFrustum(inFrustum: Frustum): ViewStatus {
    const frustum = inFrustum.clone(); // make sure we don't modify input frustum
    frustum.fixPointOrder();
    const frustPts = frustum.points;
    const viewOrg = frustPts[Npc.LeftBottomRear];

    // frustumX, frustumY, frustumZ are vectors along edges of the frustum. They are NOT unit vectors.
    // X and Y should be perpendicular, and Z should be right handed.
    const frustumX = Vector3d.createFrom(frustPts[Npc.RightBottomRear].minus(viewOrg));
    const frustumY = Vector3d.createFrom(frustPts[Npc.LeftTopRear].minus(viewOrg));
    const frustumZ = Vector3d.createFrom(frustPts[Npc.LeftBottomFront].minus(viewOrg));

    const frustMatrix = Matrix3d.createRigidFromColumns(frustumX, frustumY, AxisOrder.XYZ);
    if (!frustMatrix)
      return ViewStatus.InvalidWindow;

    // if we're close to one of the standard views, adjust to it to remove any "fuzz"
    StandardView.adjustToStandardRotation(frustMatrix);

    const xDir = frustMatrix.getColumn(0);
    const yDir = frustMatrix.getColumn(1);
    const zDir = frustMatrix.getColumn(2);

    // set up view Rotation matrix as rows of frustum matrix.
    const viewRot = frustMatrix.inverse();
    if (!viewRot)
      return ViewStatus.InvalidWindow;

    // Left handed frustum?
    const zSize = zDir.dotProduct(frustumZ);
    if (zSize < 0.0)
      return ViewStatus.InvalidWindow;

    const viewDiagRoot = new Vector3d();
    viewDiagRoot.plus2Scaled(xDir, xDir.dotProduct(frustumX), yDir, yDir.dotProduct(frustumY), viewDiagRoot);  // vectors on the back plane
    viewDiagRoot.plusScaled(zDir, zSize, viewDiagRoot);       // add in z vector perpendicular to x,y

    // use center of frustum and view diagonal for origin. Original frustum may not have been orthogonal
    frustum.getCenter().plusScaled(viewDiagRoot, -0.5, viewOrg);

    // delta is in view coordinates
    const viewDelta = viewRot.multiplyVector(viewDiagRoot);
    this.validateViewDelta(viewDelta, false);

    this.setOrigin(viewOrg);
    this.setExtents(viewDelta);
    this.setRotation(viewRot);
    return ViewStatus.Success;
  }

  /** Get or set the largest and smallest values allowed for the extents for this ViewState
   * The default limits vary based on the type of view:
   *   - Spatial view extents cannot exceed the diameter of the earth.
   *   - Drawing view extents cannot exceed twice the longest axis of the drawing model's range.
   *   - Sheet view extents cannot exceed ten times the paper size of the sheet.
   * Explicitly setting the extent limits overrides the default limits.
   * @see [[resetExtentLimits]] to restore the default limits.
   */
  public get extentLimits(): ExtentLimits { return undefined !== this._extentLimits ? this._extentLimits : this.defaultExtentLimits; }
  public set extentLimits(limits: ExtentLimits) { this._extentLimits = limits; }

  /** Resets the largest and smallest values allowed for the extents of this ViewState to their default values.
   * @see [[extentLimits]].
   */
  public resetExtentLimits(): void { this._extentLimits = undefined; }

  /** Returns the default extent limits for this ViewState. These limits are used if the [[extentLimits]] have not been explicitly overridden.
   */
  public abstract get defaultExtentLimits(): ExtentLimits;

  public setDisplayStyle(style: DisplayStyleState) { this.displayStyle = style; }
  public getDetails(): any { if (!this.jsonProperties.viewDetails) this.jsonProperties.viewDetails = new Object(); return this.jsonProperties.viewDetails; }

  /** @internal */
  protected adjustAspectRatio(windowAspect: number): void {
    const extents = this.getExtents();
    const viewAspect = extents.x / extents.y;
    windowAspect *= this.getAspectRatioSkew();

    if (Math.abs(1.0 - (viewAspect / windowAspect)) < 1.0e-9)
      return;

    const oldDelta = extents.clone();
    if (viewAspect > windowAspect)
      extents.y = extents.x / windowAspect;
    else
      extents.x = extents.y * windowAspect;

    let origin = this.getOrigin();
    const trans = Transform.createOriginAndMatrix(Point3d.createZero(), this.getRotation());
    const newOrigin = trans.multiplyPoint3d(origin);

    newOrigin.x += ((oldDelta.x - extents.x) / 2.0);
    newOrigin.y += ((oldDelta.y - extents.y) / 2.0);

    origin = trans.inverse()!.multiplyPoint3d(newOrigin);
    this.setOrigin(origin);
    this.setExtents(extents);
  }

  /** @internal */
  public showFrustumErrorMessage(status: ViewStatus): void {
    let key: string;
    switch (status) {
      case ViewStatus.InvalidWindow: key = "InvalidWindow"; break;
      case ViewStatus.MaxWindow: key = "MaxWindow"; break;
      case ViewStatus.MinWindow: key = "MinWindow"; break;
      case ViewStatus.MaxZoom: key = "MaxZoom"; break;
      default:
        return;
    }
    IModelApp.notifications.outputMessage(new NotifyMessageDetails(OutputMessagePriority.Error, IModelApp.i18n.translate("Viewing." + key)));
  }

  /** @internal */
  public validateViewDelta(delta: Vector3d, messageNeeded?: boolean): ViewStatus {
    const limit = this.extentLimits;
    let error = ViewStatus.Success;

    const limitWindowSize = (v: number, ignoreError: boolean) => {
      if (v < limit.min) {
        v = limit.min;
        if (!ignoreError)
          error = ViewStatus.MinWindow;
      } else if (v > limit.max) {
        v = limit.max;
        if (!ignoreError)
          error = ViewStatus.MaxWindow;
      }
      return v;
    };

    delta.x = limitWindowSize(delta.x, false);
    delta.y = limitWindowSize(delta.y, false);
    delta.z = limitWindowSize(delta.z, true);   // We ignore z error messages for the sake of 2D views

    if (messageNeeded && error !== ViewStatus.Success)
      this.showFrustumErrorMessage(error);

    return error;
  }

  /** Returns the view detail associated with the specified name, or undefined if none such exists.
   * @internal
   */
  public peekDetail(name: string): any { return this.getDetails()[name]; }

  /** Get the current value of a view detail. If not present, returns an empty object.
   * @internal
   */
  public getDetail(name: string): any { const v = this.getDetails()[name]; return v ? v : {}; }

  /** Change the value of a view detail.
   * @internal
   */
  public setDetail(name: string, value: any) { this.getDetails()[name] = value; }

  /** Remove a view detail.
   * @internal
   */
  public removeDetail(name: string) { delete this.getDetails()[name]; }

  /** Set the CategorySelector for this view. */
  public setCategorySelector(categories: CategorySelectorState) { this.categorySelector = categories; }

  /** get the auxiliary coordinate system state object for this ViewState. */
  public get auxiliaryCoordinateSystem(): AuxCoordSystemState {
    if (!this._auxCoordSystem)
      this._auxCoordSystem = this.createAuxCoordSystem("");
    return this._auxCoordSystem;
  }

  /** Get the Id of the auxiliary coordinate system for this ViewState */
  public getAuxiliaryCoordinateSystemId(): Id64String { return Id64.fromJSON(this.getDetail("acs")); }

  /** Set or clear the AuxiliaryCoordinateSystem for this view.
   * @param acs the new AuxiliaryCoordinateSystem for this view. If undefined, no AuxiliaryCoordinateSystem will be used.
   */
  public setAuxiliaryCoordinateSystem(acs?: AuxCoordSystemState) {
    this._auxCoordSystem = acs;
    if (acs)
      this.setDetail("acs", acs.id);
    else
      this.removeDetail("acs");
  }

  /** Determine whether the specified Category is displayed in this view */
  public viewsCategory(id: Id64String): boolean { return this.categorySelector.isCategoryViewed(id); }

  /**  Get the aspect ratio (width/height) of this view */
  public getAspectRatio(): number { const extents = this.getExtents(); return extents.x / extents.y; }

  /** Get the aspect ratio skew (x/y, usually 1.0) that is used to exaggerate one axis of the view. */
  public getAspectRatioSkew(): number { return JsonUtils.asDouble(this.getDetail("aspectSkew"), 1.0); }

  /** Set the aspect ratio skew (x/y) for this view. To remove aspect ratio skew, pass 1.0 for val. */
  public setAspectRatioSkew(val: number) {
    if (!val || val === 1.0) {
      this.removeDetail("aspectSkew");
    } else {
      this.setDetail("aspectSkew", val);
    }
  }

  /** Get the unit vector that points in the view X (left-to-right) direction.
   * @param result optional Vector3d to be used for output. If undefined, a new object is created.
   */
  public getXVector(result?: Vector3d): Vector3d { return this.getRotation().getRow(0, result); }

  /** Get the unit vector that points in the view Y (bottom-to-top) direction.
   * @param result optional Vector3d to be used for output. If undefined, a new object is created.
   */
  public getYVector(result?: Vector3d): Vector3d { return this.getRotation().getRow(1, result); }

  /** Get the unit vector that points in the view Z (front-to-back) direction.
   * @param result optional Vector3d to be used for output. If undefined, a new object is created.
   */
  public getZVector(result?: Vector3d): Vector3d { return this.getRotation().getRow(2, result); }

  /** Set or clear the clipping volume for this view.
   * @param clip the new clipping volume. If undefined, clipping is removed from view.
   * @note The ViewState takes ownership of the supplied ClipVector - it should not be modified after passing it to this function.
   */
  public setViewClip(clip?: ClipVector) {
    this._clipVector = clip;
    if (clip && clip.isValid)
      this.setDetail("clip", clip.toJSON());
    else
      this.removeDetail("clip");
  }

  /** Get the clipping volume for this view, if defined
   * @note Do *not* modify the returned ClipVector. If you wish to change the ClipVector, clone the returned ClipVector, modify it as desired, and pass the clone to [[setViewClip]].
   */
  public getViewClip(): ClipVector | undefined {
    if (undefined === this._clipVector) {
      const clip = this.peekDetail("clip");
      this._clipVector = (undefined !== clip ? ClipVector.fromJSON(clip) : ClipVector.createEmpty());
    }
    return this._clipVector.isValid ? this._clipVector : undefined;
  }

  /** Set the grid settings for this view */
  public setGridSettings(orientation: GridOrientationType, spacing: Point2d, gridsPerRef: number): void {
    switch (orientation) {
      case GridOrientationType.WorldYZ:
      case GridOrientationType.WorldXZ:
        if (!this.is3d())
          return;
        break;
    }

    const details = this.getDetails();
    JsonUtils.setOrRemoveNumber(details, "gridOrient", orientation, GridOrientationType.WorldXY);
    JsonUtils.setOrRemoveNumber(details, "gridPerRef", gridsPerRef, 10);
    JsonUtils.setOrRemoveNumber(details, "gridSpaceX", spacing.x, 1.0);
    JsonUtils.setOrRemoveNumber(details, "gridSpaceY", spacing.y, spacing.x);
  }

  /** Populate the given origin and rotation with information from the grid settings from the grid orientation. */
  public getGridSettings(vp: Viewport, origin: Point3d, rMatrix: Matrix3d, orientation: GridOrientationType) {
    // start with global origin (for spatial views) and identity matrix
    rMatrix.setIdentity();
    origin.setFrom(vp.view.isSpatialView() ? vp.view.iModel.globalOrigin : Point3d.create());

    switch (orientation) {
      case GridOrientationType.View: {
        const centerWorld = Point3d.create(0.5, 0.5, 0.5);
        vp.npcToWorld(centerWorld, centerWorld);

        rMatrix.setFrom(vp.rotation);
        rMatrix.multiplyXYZtoXYZ(origin, origin);
        origin.z = centerWorld.z;
        rMatrix.multiplyTransposeVectorInPlace(origin);
        break;
      }
      case GridOrientationType.WorldXY:
        break;
      case GridOrientationType.WorldYZ: {
        const rowX = rMatrix.getRow(0);
        const rowY = rMatrix.getRow(1);
        const rowZ = rMatrix.getRow(2);
        rMatrix.setRow(0, rowY);
        rMatrix.setRow(1, rowZ);
        rMatrix.setRow(2, rowX);
        break;
      }
      case GridOrientationType.WorldXZ: {
        const rowX = rMatrix.getRow(0);
        const rowY = rMatrix.getRow(1);
        const rowZ = rMatrix.getRow(2);
        rMatrix.setRow(0, rowX);
        rMatrix.setRow(1, rowZ);
        rMatrix.setRow(2, rowY);
        break;
      }
    }
  }

  /** Get the grid settings for this view */
  public getGridOrientation(): GridOrientationType { return JsonUtils.asInt(this.getDetail("gridOrient"), GridOrientationType.WorldXY); }
  public getGridsPerRef(): number { return JsonUtils.asInt(this.getDetail("gridPerRef"), 10); }
  public getGridSpacing(): XAndY {
    const x = JsonUtils.asInt(this.getDetail("gridSpaceX"), 1.0);
    return { x, y: JsonUtils.asInt(this.getDetail("gridSpaceY"), x) };
  }

  /** Change the volume that this view displays, keeping its current rotation.
   * @param volume The new volume, in world-coordinates, for the view. The resulting view will show all of worldVolume, by fitting a
   * view-axis-aligned bounding box around it. For views that are not aligned with the world coordinate system, this will sometimes
   * result in a much larger volume than worldVolume.
   * @param aspect The X/Y aspect ratio of the view into which the result will be displayed. If the aspect ratio of the volume does not
   * match aspect, the shorter axis is lengthened and the volume is centered. If aspect is undefined, no adjustment is made.
   * @param margin The amount of "white space" to leave around the view volume (which essentially increases the volume
   * of space shown in the view.) If undefined, no additional white space is added.
   * @note for 2d views, only the X and Y values of volume are used.
   */
  public lookAtVolume(volume: LowAndHighXYZ | LowAndHighXY, aspect?: number, margin?: MarginPercent) {
    const rangeBox = Frustum.fromRange(volume).points;
    this.getRotation().multiplyVectorArrayInPlace(rangeBox);
    return this.lookAtViewAlignedVolume(Range3d.createArray(rangeBox), aspect, margin);
  }

  /** Look at a volume of space defined by a range in view local coordinates, keeping its current rotation.
   * @param volume The new volume, in view-coordinates, for the view. The resulting view will show all of volume.
   * @param aspect The X/Y aspect ratio of the view into which the result will be displayed. If the aspect ratio of the volume does not
   * match aspect, the shorter axis is lengthened and the volume is centered. If aspect is undefined, no adjustment is made.
   * @param margin The amount of "white space" to leave around the view volume (which essentially increases the volume
   * of space shown in the view.) If undefined, no additional white space is added.
   * @see lookAtVolume
   */
  public lookAtViewAlignedVolume(volume: Range3d, aspect?: number, margin?: MarginPercent) {
    if (volume.isNull) // make sure volume is valid
      return;

    const viewRot = this.getRotation();
    const newOrigin = volume.low.clone();
    let newDelta = Vector3d.createStartEnd(volume.low, volume.high);

    const minimumDepth = Constant.oneMillimeter;
    if (newDelta.z < minimumDepth) {
      newOrigin.z -= (minimumDepth - newDelta.z) / 2.0;
      newDelta.z = minimumDepth;
    }

    let origNewDelta = newDelta.clone();

    const isCameraOn: boolean = this.is3d() && this.isCameraOn;
    if (isCameraOn) {
      // If the camera is on, the only way to guarantee we can see the entire volume is to set delta at the front plane, not focus plane.
      // That generally causes the view to be too large (objects in it are too small), since we can't tell whether the objects are at
      // the front or back of the view. For this reason, don't attempt to add any "margin" to camera views.
    } else if (margin) {
      // compute how much space we'll need for both of X and Y margins in root coordinates
      const wPercent = margin.left + margin.right;
      const hPercent = margin.top + margin.bottom;

      const marginHorizontal = wPercent / (1 - wPercent) * newDelta.x;
      const marginVert = hPercent / (1 - hPercent) * newDelta.y;

      // compute left and bottom margins in root coordinates
      const marginLeft = margin.left / (1 - wPercent) * newDelta.x;
      const marginBottom = margin.bottom / (1 - hPercent) * newDelta.y;

      // add the margins to the range
      newOrigin.x -= marginLeft;
      newOrigin.y -= marginBottom;
      newDelta.x += marginHorizontal;
      newDelta.y += marginVert;

      // don't fix the origin due to changes in delta here
      origNewDelta = newDelta.clone();
    } else {
      newDelta.scale(1.04, newDelta); // default "dilation"
    }

    if (isCameraOn) {
      // make sure that the zDelta is large enough so that entire model will be visible from any rotation
      const diag = newDelta.magnitudeXY();
      if (diag > newDelta.z)
        newDelta.z = diag;
    }

    this.validateViewDelta(newDelta, true);

    this.setExtents(newDelta);
    if (aspect)
      this.adjustAspectRatio(aspect);

    newDelta = this.getExtents();

    newOrigin.x -= (newDelta.x - origNewDelta.x) / 2.0;
    newOrigin.y -= (newDelta.y - origNewDelta.y) / 2.0;
    newOrigin.z -= (newDelta.z - origNewDelta.z) / 2.0;

    viewRot.multiplyTransposeVectorInPlace(newOrigin);
    this.setOrigin(newOrigin);

    if (!this.is3d())
      return;

    const cameraDef: Camera = this.camera;
    cameraDef.validateLens();
    // move the camera back so the entire x,y range is visible at front plane
    const frontDist = Math.max(newDelta.x, newDelta.y) / (2.0 * Math.tan(cameraDef.getLensAngle().radians / 2.0));
    const backDist = frontDist + newDelta.z;

    cameraDef.setFocusDistance(frontDist); // do this even if the camera isn't currently on.
    this.centerEyePoint(backDist); // do this even if the camera isn't currently on.
    this.verifyFocusPlane(); // changes delta/origin
  }

  private addModelToScene(model: TileTreeModelState, context: SceneContext): void {
    const animId = undefined !== this.scheduleScript ? this.scheduleScript.getModelAnimationId(model.treeModelId) : undefined;
    model.loadTree(context.viewFlags.edgesRequired(), animId);
    if (undefined !== model.tileTree)
      model.tileTree.drawScene(context);
  }

  /** Set the rotation of this ViewState to the supplied rotation, by rotating it about a point.
   * @param rotation The new rotation matrix for this ViewState.
   * @param point The point to rotate about. If undefined, use the [[getTargetPoint]].
   */
  public setRotationAboutPoint(rotation: Matrix3d, point?: Point3d): void {
    if (undefined === point)
      point = this.getTargetPoint();

    const inverse = rotation.clone().inverse();
    if (undefined === inverse)
      return;

    const targetMatrix = inverse.multiplyMatrixMatrix(this.getRotation());
    const worldTransform = Transform.createFixedPointAndMatrix(point, targetMatrix);
    const frustum = this.calculateFrustum();
    if (undefined !== frustum) {
      frustum.multiply(worldTransform);
      this.setupFromFrustum(frustum);
    }
  }
}

/** Defines the state of a view of 3d models.
 * @see [ViewState Parameters]($docs/learning/frontend/views#viewstate-parameters)
 * @public
 */
export abstract class ViewState3d extends ViewState {
  /** True if the camera is valid. */
  protected _cameraOn: boolean;
  /** The lower left back corner of the view frustum. */
  public readonly origin: Point3d;
  /** The extent of the view frustum. */
  public readonly extents: Vector3d;
  /** Rotation of the view frustum. */
  public readonly rotation: Matrix3d;
  /** The camera used for this view. */
  public readonly camera: Camera;
  /** Minimum distance for front plane */
  public forceMinFrontDist = 0.0;
  /** The name of the associated ECClass */
  public static get className() { return "ViewDefinition3d"; }
  public onRenderFrame(_viewport: Viewport): void { }
  public allow3dManipulations(): boolean { return true; }
  public constructor(props: ViewDefinition3dProps, iModel: IModelConnection, categories: CategorySelectorState, displayStyle: DisplayStyle3dState) {
    super(props, iModel, categories, displayStyle);
    this._cameraOn = JsonUtils.asBool(props.cameraOn);
    this.origin = Point3d.fromJSON(props.origin);
    this.extents = Vector3d.fromJSON(props.extents);
    this.rotation = YawPitchRollAngles.fromJSON(props.angles).toMatrix3d();
    assert(this.rotation.isRigid());
    this.camera = new Camera(props.camera);
  }

  /** @internal */
  public saveForUndo(): ViewStateUndo { return new ViewState3dUndo(this); }

  /** @internal */
  public setFromUndo(val: ViewState3dUndo) {
    this._cameraOn = val.cameraOn;
    this.origin.setFrom(val.origin);
    this.extents.setFrom(val.extents);
    this.rotation.setFrom(val.rotation);
    this.camera.setFrom(val.camera);
  }

  public toJSON(): ViewDefinition3dProps {
    const val = super.toJSON() as ViewDefinition3dProps;
    val.cameraOn = this._cameraOn;
    val.origin = this.origin;
    val.extents = this.extents;
    val.angles = YawPitchRollAngles.createFromMatrix3d(this.rotation)!.toJSON();
    val.camera = this.camera;
    return val;
  }

  public get isCameraOn(): boolean { return this._cameraOn; }
  public setupFromFrustum(frustum: Frustum): ViewStatus {
    const stat = super.setupFromFrustum(frustum);
    if (ViewStatus.Success !== stat)
      return stat;

    this.turnCameraOff();
    const frustPts = frustum.points;

    // use comparison of back, front plane X sizes to indicate camera or flat view ...
    const xBack = frustPts[Npc.LeftBottomRear].distance(frustPts[Npc.RightBottomRear]);
    const xFront = frustPts[Npc.LeftBottomFront].distance(frustPts[Npc.RightBottomFront]);

    const flatViewFractionTolerance = 1.0e-6;
    if (xFront > xBack * (1.0 + flatViewFractionTolerance))
      return ViewStatus.InvalidWindow;

    // see if the frustum is tapered, and if so, set up camera eyepoint and adjust viewOrg and delta.
    const compression = xFront / xBack;
    if (compression >= (1.0 - flatViewFractionTolerance))
      return ViewStatus.Success;

    // the frustum has perspective, turn camera on
    let viewOrg = frustPts[Npc.LeftBottomRear];
    const viewDelta = this.getExtents().clone();
    const zDir = this.getZVector();
    const frustumZ = viewOrg.vectorTo(frustPts[Npc.LeftBottomFront]);
    const frustOrgToEye = frustumZ.scale(1.0 / (1.0 - compression));
    const eyePoint = viewOrg.plus(frustOrgToEye);

    const backDistance = frustOrgToEye.dotProduct(zDir);         // distance from eye to back plane of frustum
    const focusDistance = backDistance - (viewDelta.z / 2.0);
    const focalFraction = focusDistance / backDistance;           // ratio of focus plane distance to back plane distance

    viewOrg = eyePoint.plus2Scaled(frustOrgToEye, -focalFraction, zDir, focusDistance - backDistance);    // now project that point onto back plane
    viewDelta.x *= focalFraction;                                  // adjust view delta for x and y so they are also at focus plane
    viewDelta.y *= focalFraction;

    this.setEyePoint(eyePoint);
    this.setFocusDistance(focusDistance);
    this.setOrigin(viewOrg);
    this.setExtents(viewDelta);
    this.setLensAngle(this.calcLensAngle());
    this.enableCamera();
    return ViewStatus.Success;
  }

  protected static calculateMaxDepth(delta: Vector3d, zVec: Vector3d): number {
    const depthRatioLimit = 1.0E8;          // Limit for depth Ratio.
    const maxTransformRowRatio = 1.0E5;
    const minXYComponent = Math.min(Math.abs(zVec.x), Math.abs(zVec.y));
    const maxDepthRatio = (0.0 === minXYComponent) ? depthRatioLimit : Math.min((maxTransformRowRatio / minXYComponent), depthRatioLimit);
    return Math.max(delta.x, delta.y) * maxDepthRatio;
  }

  public getOrigin(): Point3d { return this.origin; }
  public getExtents(): Vector3d { return this.extents; }
  public getRotation(): Matrix3d { return this.rotation; }
  public setOrigin(origin: XYAndZ) { this.origin.setFrom(origin); }
  public setExtents(extents: XYAndZ) { this.extents.setFrom(extents); }
  public setRotation(rot: Matrix3d) { this.rotation.setFrom(rot); }
  /** @internal */
  protected enableCamera(): void { if (this.supportsCamera()) this._cameraOn = true; }
  public supportsCamera(): boolean { return true; }
  public minimumFrontDistance() { return Math.max(15.2 * Constant.oneCentimeter, this.forceMinFrontDist); }
  public isEyePointAbove(elevation: number): boolean { return !this._cameraOn ? (this.getZVector().z > 0) : (this.getEyePoint().z > elevation); }

  public getDisplayStyle3d() { return this.displayStyle as DisplayStyle3dState; }

  /** Turn the camera off for this view. After this call, the camera parameters in this view definition are ignored and views that use it will
   * display with an orthographic (infinite focal length) projection of the view volume from the view direction.
   * @note To turn the camera back on, call #lookAt
   */
  public turnCameraOff() { this._cameraOn = false; }

  /** Determine whether the camera is valid for this view */
  public get isCameraValid() { return this.camera.isValid; }

  /** Calculate the lens angle formed by the current delta and focus distance */
  public calcLensAngle(): Angle {
    const maxDelta = Math.max(this.extents.x, this.extents.y);
    return Angle.createRadians(2.0 * Math.atan2(maxDelta * 0.5, this.camera.getFocusDistance()));
  }

  /** Get the target point of the view. If there is no camera, view center is returned. */
  public getTargetPoint(result?: Point3d): Point3d {
    if (!this._cameraOn)
      return super.getTargetPoint(result);

    const viewZ = this.getRotation().getRow(2);
    return this.getEyePoint().plusScaled(viewZ, -1.0 * this.getFocusDistance(), result);
  }

  /** Position the camera for this view and point it at a new target point.
   * @param eyePoint The new location of the camera.
   * @param targetPoint The new location to which the camera should point. This becomes the center of the view on the focus plane.
   * @param upVector A vector that orients the camera's "up" (view y). This vector must not be parallel to the vector from eye to target.
   * @param newExtents  The new size (width and height) of the view rectangle. The view rectangle is on the focus plane centered on the targetPoint.
   * If newExtents is undefined, the existing size is unchanged.
   * @param frontDistance The distance from the eyePoint to the front plane. If undefined, the existing front distance is used.
   * @param backDistance The distance from the eyePoint to the back plane. If undefined, the existing back distance is used.
   * @returns A [[ViewStatus]] indicating whether the camera was successfully positioned.
   * @note If the aspect ratio of viewDelta does not match the aspect ratio of a Viewport into which this view is displayed, it will be
   * adjusted when the [[Viewport]] is synchronized from this view.
   */
  public lookAt(eyePoint: XYAndZ, targetPoint: XYAndZ, upVector: Vector3d, newExtents?: XAndY, frontDistance?: number, backDistance?: number): ViewStatus {
    const eye = new Point3d(eyePoint.x, eyePoint.y, eyePoint.z);
    const yVec = upVector.normalize();
    if (!yVec) // up vector zero length?
      return ViewStatus.InvalidUpVector;

    const zVec = Vector3d.createStartEnd(targetPoint, eye); // z defined by direction from eye to target
    const focusDist = zVec.normalizeWithLength(zVec).mag; // set focus at target point
    const minFrontDist = this.minimumFrontDistance();

    if (focusDist <= minFrontDist) // eye and target are too close together
      return ViewStatus.InvalidTargetPoint;

    const xVec = new Vector3d();
    if (yVec.crossProduct(zVec).normalizeWithLength(xVec).mag < Geometry.smallMetricDistance)
      return ViewStatus.InvalidUpVector;    // up is parallel to z

    if (zVec.crossProduct(xVec).normalizeWithLength(yVec).mag < Geometry.smallMetricDistance)
      return ViewStatus.InvalidUpVector;

    // we now have rows of the rotation matrix
    const rotation = Matrix3d.createRows(xVec, yVec, zVec);

    backDistance = backDistance ? backDistance : this.getBackDistance();
    frontDistance = frontDistance ? frontDistance : this.getFrontDistance();

    const delta = newExtents ? new Vector3d(Math.abs(newExtents.x), Math.abs(newExtents.y), this.extents.z) : this.extents.clone();

    frontDistance = Math.max(frontDistance!, (.5 * Constant.oneMeter));
    backDistance = Math.max(backDistance!, focusDist + (.5 * Constant.oneMeter));

    if (backDistance < focusDist) // make sure focus distance is in front of back distance.
      backDistance = focusDist + Constant.oneMillimeter;

    if (frontDistance > focusDist)
      frontDistance = focusDist - minFrontDist;

    if (frontDistance < minFrontDist)
      frontDistance = minFrontDist;

    delta.z = (backDistance - frontDistance);

    const frontDelta = delta.scale(frontDistance / focusDist);
    const stat = this.validateViewDelta(frontDelta, false); // validate window size on front (smallest) plane
    if (ViewStatus.Success !== stat)
      return stat;

    if (delta.z > ViewState3d.calculateMaxDepth(delta, zVec)) // make sure we're not zoomed out too far
      return ViewStatus.MaxDisplayDepth;

    // The origin is defined as the lower left of the view rectangle on the focus plane, projected to the back plane.
    // Start at eye point, and move to center of back plane, then move left half of width. and down half of height
    const origin = eye.plus3Scaled(zVec, -backDistance!, xVec, -0.5 * delta.x, yVec, -0.5 * delta.y);

    this.setEyePoint(eyePoint);
    this.setRotation(rotation);
    this.setFocusDistance(focusDist);
    this.setOrigin(origin);
    this.setExtents(delta);
    this.setLensAngle(this.calcLensAngle());
    this.enableCamera();
    return ViewStatus.Success;
  }

  /** Position the camera for this view and point it at a new target point, using a specified lens angle.
   * @param eyePoint The new location of the camera.
   * @param targetPoint The new location to which the camera should point. This becomes the center of the view on the focus plane.
   * @param upVector A vector that orients the camera's "up" (view y). This vector must not be parallel to the vector from eye to target.
   * @param fov The angle, in radians, that defines the field-of-view for the camera. Must be between .0001 and pi.
   * @param frontDistance The distance from the eyePoint to the front plane. If undefined, the existing front distance is used.
   * @param backDistance The distance from the eyePoint to the back plane. If undefined, the existing back distance is used.
   * @returns [[ViewStatus]] indicating whether the camera was successfully positioned.
   * @note The aspect ratio of the view remains unchanged.
   */
  public lookAtUsingLensAngle(eyePoint: Point3d, targetPoint: Point3d, upVector: Vector3d, fov: Angle, frontDistance?: number, backDistance?: number): ViewStatus {
    const focusDist = eyePoint.vectorTo(targetPoint).magnitude();   // Set focus at target point

    if (focusDist <= Constant.oneMillimeter)       // eye and target are too close together
      return ViewStatus.InvalidTargetPoint;

    if (fov.radians < .0001 || fov.radians > Math.PI)
      return ViewStatus.InvalidLens;

    const extent = 2.0 * Math.tan(fov.radians / 2.0) * focusDist;
    const delta = Vector2d.create(this.extents.x, this.extents.y);
    const longAxis = Math.max(delta.x, delta.y);
    delta.scale(extent / longAxis, delta);

    return this.lookAt(eyePoint, targetPoint, upVector, delta, frontDistance, backDistance);
  }

  /** Move the camera relative to its current location by a distance in camera coordinates.
   * @param distance to move camera. Length is in world units, direction relative to current camera orientation.
   * @returns Status indicating whether the camera was successfully positioned. See values at [[ViewStatus]] for possible errors.
   */
  public moveCameraLocal(distance: Vector3d): ViewStatus {
    const distWorld = this.getRotation().multiplyTransposeVector(distance);
    return this.moveCameraWorld(distWorld);
  }

  /** Move the camera relative to its current location by a distance in world coordinates.
   * @param distance in world units.
   * @returns Status indicating whether the camera was successfully positioned. See values at [[ViewStatus]] for possible errors.
   */
  public moveCameraWorld(distance: Vector3d): ViewStatus {
    if (!this._cameraOn) {
      this.origin.plus(distance, this.origin);
      return ViewStatus.Success;
    }

    const newTarget = this.getTargetPoint().plus(distance);
    const newEyePt = this.getEyePoint().plus(distance);
    return this.lookAt(newEyePt, newTarget, this.getYVector());
  }

  /** Rotate the camera from its current location about an axis relative to its current orientation.
   * @param angle The angle to rotate the camera.
   * @param axis The axis about which to rotate the camera. The axis is a direction relative to the current camera orientation.
   * @param aboutPt The point, in world coordinates, about which the camera is rotated. If aboutPt is undefined, the camera rotates in place
   *  (i.e. about the current eyePoint).
   * @note Even though the axis is relative to the current camera orientation, the aboutPt is in world coordinates, \b not relative to the camera.
   * @returns Status indicating whether the camera was successfully positioned. See values at [[ViewStatus]] for possible errors.
   */
  public rotateCameraLocal(angle: Angle, axis: Vector3d, aboutPt?: Point3d): ViewStatus {
    const axisWorld = this.getRotation().multiplyTransposeVector(axis);
    return this.rotateCameraWorld(angle, axisWorld, aboutPt);
  }

  /** Rotate the camera from its current location about an axis in world coordinates.
   * @param angle The angle to rotate the camera.
   * @param axis The world-based axis (direction) about which to rotate the camera.
   * @param aboutPt The point, in world coordinates, about which the camera is rotated. If aboutPt is undefined, the camera rotates in place
   *  (i.e. about the current eyePoint).
   * @returns Status indicating whether the camera was successfully positioned. See values at [[ViewStatus]] for possible errors.
   */
  public rotateCameraWorld(angle: Angle, axis: Vector3d, aboutPt?: Point3d): ViewStatus {
    const about = aboutPt ? aboutPt : this.getEyePoint();
    const rotation = Matrix3d.createRotationAroundVector(axis, angle);
    if (!rotation)
      return ViewStatus.InvalidUpVector;    // Invalid axis given
    const trans = Transform.createFixedPointAndMatrix(about, rotation);
    const newTarget = trans.multiplyPoint3d(this.getTargetPoint());
    const upVec = rotation!.multiplyVector(this.getYVector());
    return this.lookAt(this.getEyePoint(), newTarget, upVec);
  }

  /** Get the distance from the eyePoint to the front plane for this view. */
  public getFrontDistance(): number { return this.getBackDistance() - this.extents.z; }

  /** Get the distance from the eyePoint to the back plane for this view. */
  public getBackDistance(): number {
    // backDist is the z component of the vector from the origin to the eyePoint .
    const eyeOrg = this.origin.vectorTo(this.getEyePoint());
    this.getRotation().multiplyVector(eyeOrg, eyeOrg);
    return eyeOrg.z;
  }

  /** Place the eyepoint of the camera so it is aligned with the center of the view. This removes any 1-point perspective skewing that may be
   * present in the current view.
   * @param backDistance If defined, the new the distance from the eyepoint to the back plane. Otherwise the distance from the
   * current eyepoint is used.
   */
  public centerEyePoint(backDistance?: number): void {
    const eyePoint = this.getExtents().scale(0.5);
    eyePoint.z = backDistance ? backDistance : this.getBackDistance();
    const eye = this.getRotation().multiplyTransposeXYZ(eyePoint.x, eyePoint.y, eyePoint.z);
    this.camera.setEyePoint(this.getOrigin().plus(eye));
  }

  /** Center the focus distance of the camera halfway between the front plane and the back plane, keeping the eyepoint,
   * lens angle, rotation, back distance, and front distance unchanged.
   * @note The focus distance, origin, and delta values are modified, but the view encloses the same volume and appears visually unchanged.
   */
  public centerFocusDistance(): void {
    const backDist = this.getBackDistance();
    const frontDist = this.getFrontDistance();
    const eye = this.getEyePoint();
    const target = eye.plusScaled(this.getZVector(), frontDist - backDist);
    this.lookAtUsingLensAngle(eye, target, this.getYVector(), this.getLensAngle(), frontDist, backDist);
  }

  /** Ensure the focus plane lies between the front and back planes. If not, center it. */
  public verifyFocusPlane(): void {
    if (!this._cameraOn)
      return;

    let backDist = this.getBackDistance();
    const frontDist = backDist - this.extents.z;
    const camera = this.camera;
    const extents = this.extents;
    const rot = this.rotation;

    if (backDist <= 0.0 || frontDist <= 0.0) {
      // the camera location is invalid. Set it based on the view range.
      const tanAngle = Math.tan(camera.lens.radians / 2.0);
      backDist = extents.z / tanAngle;
      camera.setFocusDistance(backDist / 2);
      this.centerEyePoint(backDist);
      return;
    }

    const focusDist = camera.focusDist;
    if (focusDist > frontDist && focusDist < backDist)
      return;

    // put it halfway between front and back planes
    camera.setFocusDistance((extents.z / 2.0) + frontDist);

    // moving the focus plane means we have to adjust the origin and delta too (they're on the focus plane, see diagram above)
    const ratio = camera.focusDist / focusDist;
    extents.x *= ratio;
    extents.y *= ratio;
    camera.eye.plus3Scaled(rot.rowZ(), -backDist, rot.rowX(), -0.5 * extents.x, rot.rowY(), -0.5 * extents.y, this.origin); // this centers the camera too
  }

  /** Get the current location of the eyePoint for camera in this view. */
  public getEyePoint(): Point3d { return this.camera.eye; }

  /** Get the lens angle for this view. */
  public getLensAngle(): Angle { return this.camera.lens; }

  /** Set the lens angle for this view.
   *  @param angle The new lens angle in radians. Must be greater than 0 and less than pi.
   *  @note This does not change the view's current field-of-view. Instead, it changes the lens that will be used if the view
   *  is subsequently modified and the lens angle is used to position the eyepoint.
   *  @note To change the field-of-view (i.e. "zoom") of a view, pass a new viewDelta to #lookAt
   */
  public setLensAngle(angle: Angle): void { this.camera.setLensAngle(angle); }

  /** Change the location of the eyePoint for the camera in this view.
   * @param pt The new eyepoint.
   * @note This method is generally for internal use only. Moving the eyePoint arbitrarily can result in skewed or illegal perspectives.
   * The most common method for user-level camera positioning is #lookAt.
   */
  public setEyePoint(pt: XYAndZ): void { this.camera.setEyePoint(pt); }

  /** Set the focus distance for this view.
   *  @note Changing the focus distance changes the plane on which the delta.x and delta.y values lie. So, changing focus distance
   *  without making corresponding changes to delta.x and delta.y essentially changes the lens angle, causing a "zoom" effect
   */
  public setFocusDistance(dist: number): void { this.camera.setFocusDistance(dist); }

  /**  Get the distance from the eyePoint to the focus plane for this view. */
  public getFocusDistance(): number { return this.camera.focusDist; }
  public createAuxCoordSystem(acsName: string): AuxCoordSystemState { return AuxCoordSystem3dState.createNew(acsName, this.iModel); }

  public decorate(context: DecorateContext): void {
    super.decorate(context);
    this.drawSkyBox(context);
    this.drawGroundPlane(context);
  }

  /** @internal */
  protected drawSkyBox(context: DecorateContext): void {
    const style3d = this.getDisplayStyle3d();
    if (!style3d.environment.sky.display)
      return;

    const vp = context.viewport;
    const skyBoxParams = style3d.loadSkyBoxParams(vp.target.renderSystem, vp);
    if (undefined !== skyBoxParams) {
      const skyBoxGraphic = IModelApp.renderSystem.createSkyBox(skyBoxParams);
      context.setSkyBox(skyBoxGraphic!);
    }
  }

  /** Returns the ground elevation taken from the environment added with the global z position of this imodel. */
  public getGroundElevation(): number {
    const env = this.getDisplayStyle3d().environment;
    return env.ground.elevation + this.iModel.globalOrigin.z;
  }

  /** Return the ground extents, which will originate either from the viewport frustum or the extents of the imodel. */
  public getGroundExtents(vp?: Viewport): AxisAlignedBox3d {
    const displayStyle = this.getDisplayStyle3d();
    const extents = new Range3d();
    if (!displayStyle.environment.ground.display)
      return extents; // Ground plane is not enabled

    const elevation = this.getGroundElevation();

    if (undefined !== vp) {
      const viewRay = Ray3d.create(Point3d.create(), vp.rotation.rowZ());
      const xyPlane = Plane3dByOriginAndUnitNormal.create(Point3d.create(0, 0, elevation), Vector3d.create(0, 0, 1));

      // first determine whether the ground plane is displayed in the view
      const worldFrust = vp.getFrustum();
      for (const point of worldFrust.points) {
        viewRay.origin = point;   // We never modify the reference
        const xyzPoint = Point3d.create();
        const param = viewRay.intersectionWithPlane(xyPlane!, xyzPoint);
        if (param === undefined)
          return extents;   // View does not show ground plane
      }
    }

    extents.setFrom(this.iModel.projectExtents);
    extents.low.z = extents.high.z = elevation;

    const center = extents.low.interpolate(.5, extents.high);

    const radius = extents.low.distance(extents.high);
    extents.setNull();
    extents.extendPoint(center);  // Extents now contains single point
    extents.low.addScaledInPlace(Vector3d.create(-1, -1, -1), radius);
    extents.high.addScaledInPlace(Vector3d.create(1, 1, 1), radius);
    extents.low.z = extents.high.z = elevation;
    return extents;
  }

  /** @internal */
  protected drawGroundPlane(context: DecorateContext): void {
    const extents = this.getGroundExtents(context.viewport);
    if (extents.isNull)
      return;

    const ground = this.getDisplayStyle3d().environment.ground;
    if (!ground.display)
      return;

    const points: Point3d[] = [extents.low.clone(), extents.low.clone(), extents.high.clone(), extents.high.clone()];
    points[1].x = extents.high.x;
    points[3].x = extents.low.x;

    const aboveGround = this.isEyePointAbove(extents.low.z);
    const gradient = ground.getGroundPlaneGradient(aboveGround);
    const texture = context.viewport.target.renderSystem.getGradientTexture(gradient, this.iModel);
    if (!texture)
      return;

    const matParams = new RenderMaterial.Params();
    matParams.diffuseColor = ColorDef.white;
    matParams.shadows = false;
    matParams.ambient = 1;
    matParams.diffuse = 0;

    const mapParams = new TextureMapping.Params();
    const transform = new TextureMapping.Trans2x3(0, 1, 0, 1, 0, 0);
    mapParams.textureMatrix = transform;
    mapParams.textureMatrix.setTransform();
    matParams.textureMapping = new TextureMapping(texture, mapParams);
    const material = context.viewport.target.renderSystem.createMaterial(matParams, this.iModel);
    if (!material)
      return;

    const params = new GraphicParams();
    params.setLineColor(gradient.keys[0].color);
    params.setFillColor(ColorDef.white);  // Fill should be set to opaque white for gradient texture...
    params.material = material;

    const builder = context.createGraphicBuilder(GraphicType.WorldDecoration);
    builder.activateGraphicParams(params);

    /// ### TODO: Until we have more support in geometry package for tracking UV coordinates of higher level geometry
    // we will use a PolyfaceBuilder here to add the ground plane as a quad, claim the polyface, and then send that to the GraphicBuilder
    const strokeOptions = new StrokeOptions();
    strokeOptions.needParams = true;
    const polyfaceBuilder = PolyfaceBuilder.create(strokeOptions);
    polyfaceBuilder.toggleReversedFacetFlag();
    const uvParams: Point2d[] = [Point2d.create(0, 0), Point2d.create(1, 0), Point2d.create(1, 1), Point2d.create(0, 1)];
    polyfaceBuilder.addQuadFacet(points, uvParams);
    const polyface = polyfaceBuilder.claimPolyface(false);

    builder.addPolyface(polyface, true);
    context.addDecorationFromBuilder(builder);
  }
}

/** Defines a view of one or more SpatialModels.
 * The list of viewed models is stored by the ModelSelector.
 * @public
 */
export class SpatialViewState extends ViewState3d {
  /** The name of the associated ECClass */
  public static get className() { return "SpatialViewDefinition"; }
  public modelSelector: ModelSelectorState;

  public static createFromProps(props: ViewStateProps, iModel: IModelConnection): ViewState | undefined {
    const cat = new CategorySelectorState(props.categorySelectorProps, iModel);
    const displayStyleState = new DisplayStyle3dState(props.displayStyleProps, iModel);
    const modelSelectorState = new ModelSelectorState(props.modelSelectorProps!, iModel);

    // use "new this" so subclasses are correct.
    return new this(props.viewDefinitionProps as SpatialViewDefinitionProps, iModel, cat, displayStyleState, modelSelectorState);
  }

  constructor(props: SpatialViewDefinitionProps, iModel: IModelConnection, arg3: CategorySelectorState, displayStyle: DisplayStyle3dState, modelSelector: ModelSelectorState) {
    super(props, iModel, arg3, displayStyle);
    this.modelSelector = modelSelector;
    if (arg3 instanceof SpatialViewState) { // from clone
      this.modelSelector = arg3.modelSelector.clone();
    }
  }

  public equals(other: this): boolean { return super.equals(other) && this.modelSelector.equals(other.modelSelector); }

  public createAuxCoordSystem(acsName: string): AuxCoordSystemState { return AuxCoordSystemSpatialState.createNew(acsName, this.iModel); }
  public get defaultExtentLimits() { return { min: Constant.oneMillimeter, max: Constant.diameterOfEarth }; }

  public computeFitRange(): AxisAlignedBox3d {
    // Loop over the current models in the model selector with loaded tile trees and union their ranges
    const range = new Range3d();
    this.forEachTileTreeModel((model: TileTreeModelState) => {   // ...if we don't want to fit context reality models this should cal forEachSpatialTileTreeModel...
      const tileTree = model.tileTree;
      if (tileTree !== undefined && tileTree.rootTile !== undefined) {
        const contentRange = tileTree.rootTile.computeWorldContentRange();
        assert(!contentRange.isNull);
        assert(contentRange.intersectsRange(this.iModel.projectExtents));

        range.extendRange(contentRange);

      }
    });

    if (range.isNull)
      range.setFrom(this.getViewedExtents());

    range.ensureMinLengths(1.0);

    return range;
  }

  public getViewedExtents(): AxisAlignedBox3d {
    const extents = Range3d.fromJSON<AxisAlignedBox3d>(this.iModel.projectExtents);
    extents.scaleAboutCenterInPlace(1.0001); // projectExtents. lying smack up against the extents is not excluded by frustum...
    extents.extendRange(this.getGroundExtents());
    return extents;
  }

  public toJSON(): SpatialViewDefinitionProps {
    const val = super.toJSON() as SpatialViewDefinitionProps;
    val.modelSelectorId = this.modelSelector.id;
    return val;
  }
  public async load(): Promise<void> {
    await super.load();
    await this.displayStyle.loadContextRealityModels();
    return this.modelSelector.load();
  }
  public viewsModel(modelId: Id64String): boolean { return this.modelSelector.containsModel(modelId); }
  public clearViewedModels() { this.modelSelector.models.clear(); }
  public addViewedModel(id: Id64String) { this.modelSelector.addModels(id); }
  public removeViewedModel(id: Id64String) { this.modelSelector.dropModels(id); }

  public forEachModel(func: (model: GeometricModelState) => void) {
    for (const modelId of this.modelSelector.models) {
      const model = this.iModel.models.getLoaded(modelId);
      const model3d = undefined !== model ? model.asGeometricModel3d : undefined;
      if (undefined !== model3d)
        func(model3d);
    }
  }

  /** @alpha */
  public forEachTileTreeModel(func: (model: TileTreeModelState) => void): void {
    this.displayStyle.forEachContextRealityModel((model: TileTreeModelState) => func(model));
    this.forEachModel((model: TileTreeModelState) => func(model));
  }

  /** @internal */
  public createSolarShadowMap(context: SceneContext): void {
    context.solarShadowMap = undefined;
    const displayStyle = this.getDisplayStyle3d();
    if (IModelApp.renderSystem.options.displaySolarShadows && this.viewFlags.shadows && displayStyle !== undefined) {
      const backgroundMapPlane = this.displayStyle.backgroundMapPlane;
      const viewFrustum = (undefined === backgroundMapPlane) ? context.viewFrustum : ViewFrustum.createFromViewportAndPlane(context.viewport, backgroundMapPlane);
      const solarDirection = displayStyle.sunDirection ? displayStyle.sunDirection : Vector3d.create(-1, -1, -1).normalize();
      if (undefined !== viewFrustum) {
        context.solarShadowMap = IModelApp.renderSystem.getSolarShadowMap(viewFrustum.getFrustum(), solarDirection!, displayStyle.settings.solarShadowsSettings, this.modelSelector, this.categorySelector, this.iModel);
        context.solarShadowMap!.collectGraphics(context);
      }
    }
  }
}

/** Defines a spatial view that displays geometry on the image plane using a parallel orthographic projection.
 * @public
 */
export class OrthographicViewState extends SpatialViewState {
  /** The name of the associated ECClass */
  public static get className() { return "OrthographicViewDefinition"; }

  constructor(props: SpatialViewDefinitionProps, iModel: IModelConnection, categories: CategorySelectorState, displayStyle: DisplayStyle3dState, modelSelector: ModelSelectorState) { super(props, iModel, categories, displayStyle, modelSelector); }

  public supportsCamera(): boolean { return false; }
}

/** Defines the state of a view of a single 2d model.
 * @public
 */
export abstract class ViewState2d extends ViewState {
  /** The name of the associated ECClass */
  public static get className() { return "ViewDefinition2d"; }
  public readonly origin: Point2d;
  public readonly delta: Point2d;
  public readonly angle: Angle;
  public readonly baseModelId: Id64String;
  private _viewedExtents?: AxisAlignedBox3d;

  public constructor(props: ViewDefinition2dProps, iModel: IModelConnection, categories: CategorySelectorState, displayStyle: DisplayStyle2dState) {
    super(props, iModel, categories, displayStyle);
    this.origin = Point2d.fromJSON(props.origin);
    this.delta = Point2d.fromJSON(props.delta);
    this.angle = Angle.fromJSON(props.angle);
    this.baseModelId = Id64.fromJSON(props.baseModelId);
  }

  public toJSON(): ViewDefinition2dProps {
    const val = super.toJSON() as ViewDefinition2dProps;
    val.origin = this.origin;
    val.delta = this.delta;
    val.angle = this.angle;
    val.baseModelId = this.baseModelId;
    return val;
  }

  /** @internal */
  public saveForUndo(): ViewStateUndo { return new ViewState2dUndo(this); }

  /** @internal */
  public setFromUndo(val: ViewState2dUndo) {
    this.origin.setFrom(val.origin);
    this.delta.setFrom(val.delta);
    this.angle.setFrom(val.angle);
  }

  /** Return the model for this 2d view. */
  public getViewedModel(): GeometricModel2dState | undefined {
    const model = this.iModel.models.getLoaded(this.baseModelId);
    if (model && !(model instanceof GeometricModel2dState))
      return undefined;

    return model;
  }

  public computeFitRange(): Range3d { return this.getViewedExtents(); }
  public getViewedExtents(): AxisAlignedBox3d {
    if (undefined === this._viewedExtents) {
      const model = this.iModel.models.getLoaded(this.baseModelId) as GeometricModelState;
      if (undefined !== model && model.isGeometricModel && undefined !== model.tileTree) {
        this._viewedExtents = Range3d.create(model.tileTree.range.low, model.tileTree.range.high);
        model.tileTree.location.multiplyRange(this._viewedExtents, this._viewedExtents);
      }
    }

    return undefined !== this._viewedExtents ? this._viewedExtents : new Range3d();
  }

  public onRenderFrame(_viewport: Viewport): void { }
  public async load(): Promise<void> {
    await super.load();
    return this.iModel.models.load(this.baseModelId);
  }

  public allow3dManipulations(): boolean { return false; }
  public getOrigin() { return new Point3d(this.origin.x, this.origin.y); }
  public getExtents() { return new Vector3d(this.delta.x, this.delta.y); }
  public getRotation() { return Matrix3d.createRotationAroundVector(Vector3d.unitZ(), this.angle)!; }
  public setExtents(delta: Vector3d) { this.delta.set(delta.x, delta.y); }
  public setOrigin(origin: Point3d) { this.origin.set(origin.x, origin.y); }
  public setRotation(rot: Matrix3d) { const xColumn = rot.getColumn(0); this.angle.setRadians(Math.atan2(xColumn.y, xColumn.x)); }
  public viewsModel(modelId: Id64String) { return this.baseModelId.toString() === modelId.toString(); }
  public forEachModel(func: (model: GeometricModelState) => void) {
    const model = this.iModel.models.getLoaded(this.baseModelId);
    const model2d = undefined !== model ? model.asGeometricModel2d : undefined;
    if (undefined !== model2d)
      func(model2d);
  }
  public createAuxCoordSystem(acsName: string): AuxCoordSystemState { return AuxCoordSystem2dState.createNew(acsName, this.iModel); }
}

/** A view of a DrawingModel
 * @public
 */
export class DrawingViewState extends ViewState2d {
  /** The name of the associated ECClass */
  public static get className() { return "DrawingViewDefinition"; }
  // Computed from the tile tree range once the tile tree is available; cached thereafter to avoid recomputing.
  private _modelLimits?: ExtentLimits;

  public static createFromProps(props: ViewStateProps, iModel: IModelConnection): ViewState | undefined {
    const cat = new CategorySelectorState(props.categorySelectorProps, iModel);
    const displayStyleState = new DisplayStyle2dState(props.displayStyleProps, iModel);
    // use "new this" so subclasses are correct
    return new this(props.viewDefinitionProps as ViewDefinition2dProps, iModel, cat, displayStyleState);
  }

  public get defaultExtentLimits() {
    if (undefined !== this._modelLimits)
      return this._modelLimits;

    const model = this.getViewedModel();
    const tree = undefined !== model ? model.tileTree : undefined;
    if (undefined === tree)
      return { min: Constant.oneMillimeter, max: Constant.diameterOfEarth };

    this._modelLimits = { min: Constant.oneMillimeter, max: 2.0 * tree.range.maxLength() };
    return this._modelLimits;
  }
}

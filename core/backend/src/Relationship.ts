/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
/** @module Relationships */

import { DbOpcode, DbResult, Id64, Id64String, Logger } from "@bentley/bentleyjs-core";
import { EntityProps, IModelError, IModelStatus } from "@bentley/imodeljs-common";
import { ECSqlStatement } from "./ECSqlStatement";
import { Entity } from "./Entity";
import { IModelDb } from "./IModelDb";
import { BackendLoggerCategory } from "./BackendLoggerCategory";

const loggerCategory = BackendLoggerCategory.Relationship;

/** Specifies the source and target elements of a [[Relationship]] instance.
 * @public
 */
export interface SourceAndTarget {
  sourceId: Id64String;
  targetId: Id64String;
}

/** Properties that are common to all types of link table ECRelationships
 * @public
 */
export interface RelationshipProps extends EntityProps, SourceAndTarget {
}

/** Base class for all link table ECRelationships
 * @public
 */
export class Relationship extends Entity implements RelationshipProps {
  public static get className(): string { return "Relationship"; }
  public readonly sourceId: Id64String;
  public readonly targetId: Id64String;

  /** @internal */
  constructor(props: RelationshipProps, iModel: IModelDb) {
    super(props, iModel);
    this.sourceId = Id64.fromJSON(props.sourceId);
    this.targetId = Id64.fromJSON(props.targetId);
  }

  /** @internal */
  public toJSON(): RelationshipProps {
    const val = super.toJSON() as RelationshipProps;
    val.sourceId = this.sourceId;
    val.targetId = this.targetId;
    return val;
  }

  public static onRootChanged(_props: RelationshipProps, _iModel: IModelDb): void { }
  public static onValidateOutput(_props: RelationshipProps, _iModel: IModelDb): void { }
  public static onDeletedDependency(_props: RelationshipProps, _iModel: IModelDb): void { }

  /** Insert this Relationship into the iModel. */
  public insert(): Id64String { return this.iModel.relationships.insertInstance(this); }
  /** Update this Relationship in the iModel. */
  public update() { this.iModel.relationships.updateInstance(this); }
  /** Delete this Relationship from the iModel. */
  public delete() { this.iModel.relationships.deleteInstance(this); }

  public static getInstance<T extends Relationship>(iModel: IModelDb, criteria: Id64String | SourceAndTarget): T { return iModel.relationships.getInstance(this.classFullName, criteria); }

  /**
   * Add a request for the locks that would be needed to carry out the specified operation.
   * @param opcode The operation that will be performed on the Relationship instance.
   */
  public buildConcurrencyControlRequest(opcode: DbOpcode): void { this.iModel.concurrencyControl.buildRequestForRelationship(this, opcode); }
}

/**A Relationship where one Element refers to another Element
 * @public
 */
export class ElementRefersToElements extends Relationship {
  public static get className(): string { return "ElementRefersToElements"; }
  /** Create an instance of the Relationship.
   * @param iModel The iModel that will contain the relationship
   * @param sourceId The sourceId of the relationship, that is, the driver element
   * @param targetId The targetId of the relationship, that is, the driven element
   * @return an instance of the specified class.
   */
  public static create<T extends ElementRefersToElements>(iModel: IModelDb, sourceId: Id64String, targetId: Id64String): T {
    return iModel.relationships.createInstance({ sourceId, targetId, classFullName: this.classFullName }) as T;
  }
  /** Insert a new instance of the Relationship.
   * @param iModel The iModel that will contain the relationship
   * @param sourceId The sourceId of the relationship, that is, the driver element
   * @param targetId The targetId of the relationship, that is, the driven element
   * @return The Id of the inserted Relationship.
   */
  public static insert<T extends ElementRefersToElements>(iModel: IModelDb, sourceId: Id64String, targetId: Id64String): Id64String {
    const relationship: T = this.create(iModel, sourceId, targetId);
    return iModel.relationships.insertInstance(relationship);
  }
}

/** Relates a [[DrawingGraphic]] to the [[Element]] that it represents
 * @public
 */
export class DrawingGraphicRepresentsElement extends ElementRefersToElements {
  public static get className(): string { return "DrawingGraphicRepresentsElement"; }
}

/** Properties that are common to all types of link table ECRelationships
 * @public
 */
export interface ElementGroupsMembersProps extends RelationshipProps {
  memberPriority: number;
}

/** An ElementRefersToElements relationship where one Element *groups* a set of other Elements.
 * @public
 */
export class ElementGroupsMembers extends ElementRefersToElements {
  public static get className(): string { return "ElementGroupsMembers"; }
  public memberPriority: number;

  constructor(props: ElementGroupsMembersProps, iModel: IModelDb) {
    super(props, iModel);
    this.memberPriority = props.memberPriority;
  }

  public static create<T extends ElementRefersToElements>(iModel: IModelDb, sourceId: Id64String, targetId: Id64String, memberPriority: number = 0): T {
    const props: ElementGroupsMembersProps = { sourceId, targetId, memberPriority, classFullName: this.classFullName };
    return iModel.relationships.createInstance(props) as T;
  }
}

/** Properties that are common to all types of ElementDrivesElements
 * @beta
 */
export interface ElementDrivesElementProps extends RelationshipProps {
  status: number;
  priority: number;
}

/** A Relationship where one Element *drives* another Element
 * @beta
 */
export class ElementDrivesElement extends Relationship implements ElementDrivesElementProps {
  public static get className(): string { return "ElementDrivesElement"; }
  public status: number;
  public priority: number;

  /** @internal */
  constructor(props: ElementDrivesElementProps, iModel: IModelDb) {
    super(props, iModel);
    this.status = props.status;
    this.priority = props.priority;
  }

  public static create<T extends ElementRefersToElements>(iModel: IModelDb, sourceId: Id64String, targetId: Id64String, priority: number = 0): T {
    const props: ElementDrivesElementProps = { sourceId, targetId, priority, status: 0, classFullName: this.classFullName };
    return iModel.relationships.createInstance(props) as T;
  }
}

/** Manages [[Relationship]]s.
 * @public
 */
export class Relationships {
  private _iModel: IModelDb;

  /** @internal */
  constructor(iModel: IModelDb) { this._iModel = iModel; }

  /** Create a new instance of a Relationship.
   * @param props The properties of the new Relationship.
   * @throws [[IModelError]] if there is a problem creating the Relationship.
   */
  public createInstance(props: RelationshipProps): Relationship { return this._iModel.constructEntity<Relationship>(props); }

  /** Insert a new relationship instance into the iModel.
   * @param props The properties of the new relationship.
   * @returns The Id of the newly inserted relationship.
   * @note The id property of the props object is set as a side effect of this function.
   * @throws [[IModelError]] if unable to insert the relationship instance.
   */
  public insertInstance(props: RelationshipProps): Id64String {
    const val = this._iModel.briefcase.nativeDb.insertLinkTableRelationship(JSON.stringify(props));
    if (val.error)
      throw new IModelError(val.error.status, "Problem inserting relationship instance", Logger.logWarning, loggerCategory);

    props.id = Id64.fromJSON(val.result);
    return props.id;
  }

  /** Update the properties of an existing relationship instance in the iModel.
   * @param props the properties of the relationship instance to update. Any properties that are not present will be left unchanged.
   * @throws [[IModelError]] if unable to update the relationship instance.
   */
  public updateInstance(props: RelationshipProps): void {
    const error = this._iModel.briefcase.nativeDb.updateLinkTableRelationship(JSON.stringify(props));
    if (error !== DbResult.BE_SQLITE_OK)
      throw new IModelError(error, "", Logger.logWarning, loggerCategory);
  }

  /** Delete an Relationship instance from this iModel.
   * @param id The Id of the Relationship to be deleted
   * @throws [[IModelError]]
   */
  public deleteInstance(props: RelationshipProps): void {
    const error = this._iModel.briefcase.nativeDb.deleteLinkTableRelationship(JSON.stringify(props));
    if (error !== DbResult.BE_SQLITE_DONE)
      throw new IModelError(error, "", Logger.logWarning, loggerCategory);
  }

  /** Get the props of a Relationship instance */
  public getInstanceProps<T extends RelationshipProps>(relClassSqlName: string, criteria: Id64String | SourceAndTarget): T {
    let props: T;
    if (typeof criteria === "string") {
      props = this._iModel.withPreparedStatement(`SELECT * FROM ${relClassSqlName} WHERE ecinstanceid=?`, (stmt: ECSqlStatement) => {
        stmt.bindId(1, criteria);
        if (DbResult.BE_SQLITE_ROW !== stmt.step())
          throw new IModelError(IModelStatus.NotFound, "Relationship not found", Logger.logWarning, loggerCategory);
        return stmt.getRow() as T;
      });
    } else {
      props = this._iModel.withPreparedStatement("SELECT * FROM " + relClassSqlName + " WHERE SourceECInstanceId=? AND TargetECInstanceId=?", (stmt: ECSqlStatement) => {
        stmt.bindId(1, criteria.sourceId);
        stmt.bindId(2, criteria.targetId);
        if (DbResult.BE_SQLITE_ROW !== stmt.step())
          throw new IModelError(IModelStatus.NotFound, "Relationship not found", Logger.logWarning, loggerCategory);
        return stmt.getRow() as T;
      });
    }
    props.classFullName = props.className.replace(".", ":");
    return props;
  }

  /** Get a Relationship instance */
  public getInstance<T extends Relationship>(relClassSqlName: string, criteria: Id64String | SourceAndTarget): T {
    return this._iModel.constructEntity<T>(this.getInstanceProps(relClassSqlName, criteria));
  }
}

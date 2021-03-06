/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/

import { SchemaItemType } from "../ECObjects";
import { ECClass } from "../Metadata/Class";
import { RelationshipClass } from "../Metadata/RelationshipClass";
import { SchemaItem } from "../Metadata/SchemaItem";
import { ISchemaPartVisitor, SchemaPartVisitorDelegate } from "../SchemaPartVisitorDelegate";
import { Schema } from "./../Metadata/Schema";

/**
 * The purpose of this class is to traverse a given schema, allowing clients to hook into
 * the traversal process via Visitors to allow for custom processing of the schema elements.
 * @internal
 */
export class SchemaWalker {
  private _visitorHelper: SchemaPartVisitorDelegate;

  // This is a cache of the schema we are traversing. The schema also exists within the _context but in order
  // to not have to go back to the context every time we use this cache.
  private _schema?: Schema;

  /**
   * Initializes a new SchemaWalker instance.
   * @param visitor An ISchemaWalkerVisitor implementation whose methods will be called during schema traversal.
   */
  constructor(visitor: ISchemaPartVisitor) {
    this._visitorHelper = new SchemaPartVisitorDelegate(visitor);
  }

  /**
   * Traverses the given Schema, calling ISchemaWalkerVisitor methods along the way.
   * @param schema The Schema to traverse.
   */
  public async traverseSchema<T extends Schema>(schema: T): Promise<T> {
    this._schema = schema;

    await this._visitorHelper.visitSchema(schema);
    await this._visitorHelper.visitSchemaPart(schema);

    const schemaItems = this._schema.getItems();

    for (const item of schemaItems) {
      await this.traverseSchemaItem(item);
    }

    return schema;
  }

  private async traverseSchemaItem(schemaItem: SchemaItem): Promise<void> {
    await this._visitorHelper.visitSchemaPart(schemaItem);

    if (schemaItem instanceof ECClass) {
      await this.traverseClass(schemaItem as ECClass);
    }
  }

  private async traverseClass(ecClass: ECClass): Promise<void> {
    if (ecClass.properties) {
      for (const property of ecClass.properties) {
        await this._visitorHelper.visitSchemaPart(property);
      }
    }

    if (ecClass.schemaItemType === SchemaItemType.RelationshipClass) {
      await this._visitorHelper.visitSchemaPart((ecClass as RelationshipClass).source);
      await this._visitorHelper.visitSchemaPart((ecClass as RelationshipClass).target);
    }
  }
}

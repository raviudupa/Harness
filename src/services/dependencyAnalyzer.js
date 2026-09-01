/**
 * Dependency Analyzer — The "Brain" of the Harness
 *
 * Analyzes an Apex class like a human developer would:
 *   - Fetches the org's valid SObject list (via describeGlobal) to ignore DTOs, inner classes, and wrappers
 *   - Layer 1: SOQL Query Mining — extracts fields from embedded SOQL
 *   - Layer 2: DML & Code Pattern Mining — finds field access on real SObjects
 *   - Layer 3: SymbolTable Cross-Reference — catches anything regex missed
 *   - Layer 4: Org Metadata Collection — validation rules, flows, triggers, record types
 *
 * Only fetches metadata for fields/objects the class actually touches.
 */

// Cache org SObject names per instanceUrl to avoid repeated global describes
const globalSObjectsCache = new Map();

/**
 * Get the set of valid SObject names in the org.
 * @param {jsforce.Connection} conn
 * @returns {Promise<Map<string, string>>} lowercaseName -> actualApiName
 */
async function getOrgSObjects(conn) {
  const cacheKey = conn.instanceUrl || 'default';
  if (globalSObjectsCache.has(cacheKey)) {
    return globalSObjectsCache.get(cacheKey);
  }

  try {
    const globalDescribe = await conn.describeGlobal();
    const map = new Map();
    for (const sobj of globalDescribe.sobjects || []) {
      map.set(sobj.name.toLowerCase(), sobj.name);
    }
    globalSObjectsCache.set(cacheKey, map);
    return map;
  } catch (err) {
    console.warn('[DependencyAnalyzer] Could not fetch global describe:', err.message);
    return new Map();
  }
}

/**
 * Extract inner class names from an Apex class body so they are never mistaken for SObjects.
 * @param {string} apexBody
 * @returns {Set<string>}
 */
function extractInnerClassNames(apexBody) {
  const innerClasses = new Set();
  const innerClassRegex = /(?:public|private|protected|global)?\s*(?:static\s+)?class\s+(\w+)/gi;
  let match;
  let isFirst = true;

  while ((match = innerClassRegex.exec(apexBody)) !== null) {
    if (isFirst) {
      // The outer class itself
      isFirst = false;
      continue;
    }
    innerClasses.add(match[1]);
  }
  return innerClasses;
}

// ─────────────────────────────────────────────────────────
// LAYER 1: SOQL Query Mining
// ─────────────────────────────────────────────────────────

/**
 * Extract SObject names and field names from SOQL queries in the Apex code.
 * @param {string} apexBody - Full Apex class source
 * @param {Map<string, string>} validSObjects - map of lowercase -> actual SObject names
 * @returns {Map<string, Set<string>>} objectName → Set of field names
 */
function extractFieldsFromSOQL(apexBody, validSObjects) {
  const objectFields = new Map();

  // Pattern 1: Bracket SOQL [SELECT ... FROM Object ...]
  const bracketRegex = /\[\s*SELECT\s+([\s\S]*?)\s+FROM\s+(\w+)([\s\S]*?)\]/gi;
  let match;

  while ((match = bracketRegex.exec(apexBody)) !== null) {
    const fieldsPart = match[1];
    const rawObjectName = match[2];
    const restPart = match[3] || '';

    const verifiedName = validSObjects.get(rawObjectName.toLowerCase()) || rawObjectName;
    addFieldsForObject(objectFields, verifiedName, fieldsPart);
    extractWhereFields(objectFields, verifiedName, restPart);
    extractSubqueryFields(objectFields, fieldsPart, validSObjects);
  }

  // Pattern 2: Dynamic SOQL via Database.query(...)
  const dynamicRegex = /Database\.query\s*\(\s*['"]([^'"]*?)['"]\s*\)/gi;
  while ((match = dynamicRegex.exec(apexBody)) !== null) {
    const soqlString = match[1];
    const innerMatch = /SELECT\s+([\s\S]*?)\s+FROM\s+(\w+)([\s\S]*)/i.exec(soqlString);
    if (innerMatch) {
      const fieldsPart = innerMatch[1];
      const rawObjectName = innerMatch[2];
      const restPart = innerMatch[3] || '';
      const verifiedName = validSObjects.get(rawObjectName.toLowerCase()) || rawObjectName;
      addFieldsForObject(objectFields, verifiedName, fieldsPart);
      extractWhereFields(objectFields, verifiedName, restPart);
    }
  }

  return objectFields;
}

function addFieldsForObject(objectFields, objectName, fieldsPart) {
  if (!objectFields.has(objectName)) {
    objectFields.set(objectName, new Set());
  }
  const fields = objectFields.get(objectName);

  const rawFields = fieldsPart.split(',').map((f) => f.trim());
  for (const raw of rawFields) {
    if (raw.startsWith('(')) continue;

    if (raw.includes('.')) {
      const parts = raw.split('.');
      fields.add(parts[0]);
    } else if (raw && !raw.includes('(')) {
      fields.add(raw);
    }
  }
}

function extractWhereFields(objectFields, objectName, restPart) {
  if (!restPart) return;

  const fields = objectFields.get(objectName) || new Set();
  if (!objectFields.has(objectName)) {
    objectFields.set(objectName, fields);
  }

  const whereMatch = /WHERE\s+([\s\S]*?)(?:ORDER|GROUP|LIMIT|OFFSET|FOR|$)/i.exec(restPart);
  if (whereMatch) {
    const whereClause = whereMatch[1];
    const fieldRegex = /(\w+)\s*(?:=|!=|<|>|<=|>=|LIKE|IN|NOT\s+IN|INCLUDES|EXCLUDES)\s*/gi;
    let fieldMatch;
    while ((fieldMatch = fieldRegex.exec(whereClause)) !== null) {
      const fieldName = fieldMatch[1];
      if (!['AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE'].includes(fieldName.toUpperCase())) {
        fields.add(fieldName);
      }
    }
  }
}

function extractSubqueryFields(objectFields, fieldsPart, validSObjects) {
  const subqueryRegex = /\(\s*SELECT\s+([\s\S]*?)\s+FROM\s+(\w+)\s*\)/gi;
  let match;
  while ((match = subqueryRegex.exec(fieldsPart)) !== null) {
    const subFields = match[1];
    const subObject = match[2];
    const verifiedName = validSObjects.get(subObject.toLowerCase()) || subObject;
    addFieldsForObject(objectFields, verifiedName, subFields);
  }
}

// ─────────────────────────────────────────────────────────
// LAYER 2: DML & Code Pattern Mining
// ─────────────────────────────────────────────────────────

/**
 * Extract field references from Apex code patterns (DML, dot-access, dynamic).
 * Strictly filters against the org's real SObjects list.
 * @param {string} apexBody
 * @param {Map<string, string>} validSObjects
 * @param {Set<string>} innerClasses
 * @returns {Map<string, Set<string>>} objectName → Set of field names
 */
function extractFieldsFromCode(apexBody, validSObjects, innerClasses) {
  const objectFields = new Map();
  const varTypeMap = new Map();

  // Helper to check if a type is a real SObject (and not an inner class/DTO)
  function isValidSObjectType(typeName) {
    if (!typeName || innerClasses.has(typeName)) return false;
    return validSObjects.has(typeName.toLowerCase());
  }

  function getRealSObjectName(typeName) {
    return validSObjects.get(typeName.toLowerCase());
  }

  // 1. Direct declaration: Account acc = ...
  const declRegex = /(\w+)\s+(\w+)\s*(?:=|;)/g;
  let match;
  while ((match = declRegex.exec(apexBody)) !== null) {
    const typeName = match[1];
    const varName = match[2];
    if (isValidSObjectType(typeName)) {
      varTypeMap.set(varName, getRealSObjectName(typeName));
    }
  }

  // 2. Collections: List<Account> accounts
  const listRegex = /(?:List|Set)\s*<\s*(\w+)\s*>\s+(\w+)/g;
  while ((match = listRegex.exec(apexBody)) !== null) {
    if (isValidSObjectType(match[1])) {
      varTypeMap.set(match[2], getRealSObjectName(match[1]));
    }
  }

  // 3. Maps: Map<Id, Contact> contactMap
  const mapRegex = /Map\s*<\s*\w+\s*,\s*(\w+)\s*>\s+(\w+)/g;
  while ((match = mapRegex.exec(apexBody)) !== null) {
    if (isValidSObjectType(match[1])) {
      varTypeMap.set(match[2], getRealSObjectName(match[1]));
    }
  }

  // 4. For-each loops: for (Contact c : contacts)
  const forEachRegex = /for\s*\(\s*(\w+)\s+(\w+)\s*:/g;
  while ((match = forEachRegex.exec(apexBody)) !== null) {
    if (isValidSObjectType(match[1])) {
      varTypeMap.set(match[2], getRealSObjectName(match[1]));
    }
  }

  // 5. Dot-access field reads/writes: var.FieldName
  const dotAccessRegex = /(\w+)\.(\w+)\s*(?:=(?!=)|;|,|\)|\]|\}|!=|==|<|>|\+|\-|\*|\/|\?|\.)/g;
  while ((match = dotAccessRegex.exec(apexBody)) !== null) {
    const varName = match[1];
    const fieldName = match[2];

    if (isKnownKeywordOrMethod(varName, fieldName)) continue;

    const objectType = varTypeMap.get(varName);
    if (objectType) {
      if (!objectFields.has(objectType)) {
        objectFields.set(objectType, new Set());
      }
      objectFields.get(objectType).add(fieldName);
    }
  }

  // 6. Instantiations: new Account(...)
  const newObjRegex = /new\s+(\w+)\s*\(/g;
  while ((match = newObjRegex.exec(apexBody)) !== null) {
    if (isValidSObjectType(match[1])) {
      const realName = getRealSObjectName(match[1]);
      if (!objectFields.has(realName)) {
        objectFields.set(realName, new Set());
      }
    }
  }

  return objectFields;
}

function isKnownKeywordOrMethod(varName, fieldName) {
  const skipVars = new Set([
    'System', 'Test', 'Database', 'Schema', 'Math', 'JSON', 'String',
    'Trigger', 'UserInfo', 'Limits', 'Label', 'ApexPages', 'Messaging',
    'Http', 'URL', 'Crypto', 'EncodingUtil', 'Pattern', 'Matcher',
    'RestContext', 'RestRequest', 'RestResponse', 'this', 'super', 'null',
  ]);
  const skipFields = new Set([
    'size', 'isEmpty', 'contains', 'get', 'put', 'add', 'remove',
    'clear', 'keySet', 'values', 'containsKey', 'clone', 'equals',
    'hashCode', 'toString', 'valueOf', 'getSObjectType', 'getDescribe',
    'addError', 'class', 'newInstance', 'request', 'response', 'requestBody',
    'responseBody', 'params', 'headers',
  ]);
  return skipVars.has(varName) || skipFields.has(fieldName);
}

// ─────────────────────────────────────────────────────────
// LAYER 3: SymbolTable Cross-Reference
// ─────────────────────────────────────────────────────────

function extractFieldsFromSymbolTable(symbolTable, validSObjects) {
  const objectFields = new Map();
  if (!symbolTable || !symbolTable.externalReferences) {
    return objectFields;
  }

  for (const extRef of symbolTable.externalReferences) {
    const refName = extRef.name;
    const verifiedName = validSObjects.get(refName.toLowerCase());

    if (verifiedName) {
      if (!objectFields.has(verifiedName)) {
        objectFields.set(verifiedName, new Set());
      }
      const fields = objectFields.get(verifiedName);

      if (extRef.variables) {
        for (const v of extRef.variables) {
          fields.add(v.name);
        }
      }
    }
  }

  return objectFields;
}

// ─────────────────────────────────────────────────────────
// LAYER 4: Org Metadata Collection
// ─────────────────────────────────────────────────────────

async function fetchValidationRules(conn, sObjectNames) {
  const rulesMap = new Map();

  for (const objName of sObjectNames) {
    try {
      const result = await conn.tooling.query(
        `SELECT Id, ValidationName, Active, ErrorMessage, Description
         FROM ValidationRule
         WHERE EntityDefinition.QualifiedApiName = '${objName}'
           AND Active = true`
      );
      rulesMap.set(objName, (result.records || []).map((r) => ({
        name: r.ValidationName,
        errorMessage: r.ErrorMessage || '',
        description: r.Description || '',
      })));
    } catch (err) {
      rulesMap.set(objName, []);
    }
  }

  return rulesMap;
}

async function fetchRecordTriggeredFlows(conn, sObjectNames) {
  const flowsMap = new Map();

  for (const objName of sObjectNames) {
    try {
      const result = await conn.tooling.query(
        `SELECT Id, DeveloperName, ProcessType, TriggerType, Status, Description
         FROM FlowDefinitionView
         WHERE TriggerObjectOrEventLabel = '${objName}'
           AND TriggerType IN ('RecordBeforeSave', 'RecordAfterSave')`
      );
      flowsMap.set(objName, (result.records || []).map((r) => ({
        name: r.DeveloperName,
        processType: r.ProcessType,
        triggerType: r.TriggerType,
        description: r.Description || '',
      })));
    } catch (err) {
      flowsMap.set(objName, []);
    }
  }

  return flowsMap;
}

async function fetchApexTriggers(conn, sObjectNames, excludeClassName) {
  const triggersMap = new Map();

  for (const objName of sObjectNames) {
    try {
      const result = await conn.tooling.query(
        `SELECT Id, Name, TableEnumOrId, Status
         FROM ApexTrigger
         WHERE TableEnumOrId = '${objName}'
           AND Status = 'Active'`
      );
      triggersMap.set(objName, (result.records || [])
        .filter((r) => r.Name !== excludeClassName)
        .map((r) => ({
          name: r.Name,
          object: r.TableEnumOrId,
        }))
      );
    } catch (err) {
      triggersMap.set(objName, []);
    }
  }

  return triggersMap;
}

function detectCustomSettingsAndMetadata(apexBody) {
  const results = new Set();
  const csRegex = /(\w+__c)\.(?:getInstance|getOrgDefaults|getValues|getAll)/g;
  let match;
  while ((match = csRegex.exec(apexBody)) !== null) {
    results.add(match[1]);
  }
  const mdtRegex = /FROM\s+(\w+__mdt)/gi;
  while ((match = mdtRegex.exec(apexBody)) !== null) {
    results.add(match[1]);
  }
  return Array.from(results);
}

function detectSharingModel(apexBody) {
  if (/\bwith\s+sharing\b/i.test(apexBody) && !/\bwithout\s+sharing\b/i.test(apexBody)) {
    return 'with sharing';
  }
  if (/\bwithout\s+sharing\b/i.test(apexBody)) {
    return 'without sharing';
  }
  if (/\binherited\s+sharing\b/i.test(apexBody)) {
    return 'inherited sharing';
  }
  return 'not specified';
}

// ─────────────────────────────────────────────────────────
// LAYER 5: Class Pattern Detection (Callouts, Interfaces, Annotations)
// ─────────────────────────────────────────────────────────

/**
 * Detect HTTP callout patterns in the Apex class.
 * If found, Claude MUST generate an HttpCalloutMock implementation.
 */
function detectCalloutPatterns(apexBody) {
  const patterns = {
    httpSend: /\bnew\s+Http\s*\(\s*\)|\bHttp\b[^.]*\.send\s*\(/i.test(apexBody),
    httpRequest: /\bnew\s+HttpRequest\s*\(/i.test(apexBody),
    futureCallout: /@future\s*\(\s*callout\s*=\s*true\s*\)/i.test(apexBody),
    webServiceCallout: /\bWebServiceCallout\.invoke/i.test(apexBody),
    namedCredential: /\bcallout:/i.test(apexBody),
    externalService: /\bExternalService\./i.test(apexBody),
  };

  const hasCallout = Object.values(patterns).some(Boolean);
  const detectedPatterns = Object.entries(patterns)
    .filter(([, found]) => found)
    .map(([name]) => name);

  return {
    hasCallout,
    patterns: detectedPatterns,
  };
}

/**
 * Detect which Apex interfaces the class implements.
 * This determines the required test pattern (Batch, Schedulable, Queueable, etc.).
 */
function detectClassInterfaces(apexBody) {
  const interfaces = {
    batchable: /\bimplements\b[^{]*\bDatabase\.Batchable\b/i.test(apexBody),
    schedulable: /\bimplements\b[^{]*\bSchedulable\b/i.test(apexBody),
    queueable: /\bimplements\b[^{]*\bQueueable\b/i.test(apexBody),
    batchFinish: /\bDatabase\.Stateful\b/i.test(apexBody),
    allowsCallouts: /\bimplements\b[^{]*\bDatabase\.AllowsCallouts\b/i.test(apexBody),
  };

  const testInstructions = [];
  if (interfaces.batchable) {
    testInstructions.push(
      'This class implements Database.Batchable. You MUST test it with: Database.executeBatch(new ClassName(), batchSize) between Test.startTest() and Test.stopTest(). Test start(), execute(), and finish() indirectly.'
    );
  }
  if (interfaces.schedulable) {
    testInstructions.push(
      'This class implements Schedulable. You MUST test it with: System.schedule("Test Job", cronExpression, new ClassName()) between Test.startTest() and Test.stopTest(). Use a cron like "0 0 0 1 1 ? 2099".'
    );
  }
  if (interfaces.queueable) {
    testInstructions.push(
      'This class implements Queueable. You MUST test it with: System.enqueueJob(new ClassName()) between Test.startTest() and Test.stopTest().'
    );
  }
  if (interfaces.allowsCallouts) {
    testInstructions.push(
      'This class implements Database.AllowsCallouts. You MUST implement and register an HttpCalloutMock before Test.startTest().'
    );
  }

  return {
    interfaces: Object.entries(interfaces).filter(([, v]) => v).map(([k]) => k),
    testInstructions,
  };
}

/**
 * Detect class-level annotations that affect test strategy.
 */
function detectClassAnnotations(apexBody) {
  const annotations = {
    restResource: /@RestResource\s*\(/i.test(apexBody),
    isTest: /@isTest/i.test(apexBody),
    invocableMethod: /@InvocableMethod/i.test(apexBody),
    invocableVariable: /@InvocableVariable/i.test(apexBody),
    auraEnabled: /@AuraEnabled/i.test(apexBody),
    remoteAction: /@RemoteAction/i.test(apexBody),
    future: /@future/i.test(apexBody),
  };

  const testInstructions = [];
  if (annotations.restResource) {
    testInstructions.push(
      'This is a @RestResource class. You MUST set up RestContext.request (with requestURI, httpMethod, requestBody as Blob) and RestContext.response before calling the methods.'
    );
  }
  if (annotations.invocableMethod) {
    testInstructions.push(
      'This class has @InvocableMethod. Call the method directly with a List input parameter. Test both valid and empty/null list inputs.'
    );
  }
  if (annotations.auraEnabled) {
    testInstructions.push(
      'This class has @AuraEnabled methods. Call them directly in the test. Wrap in try/catch for AuraHandledException testing.'
    );
  }
  if (annotations.future) {
    testInstructions.push(
      'This class has @future methods. Call them between Test.startTest() and Test.stopTest() so they execute synchronously in the test context.'
    );
  }

  return {
    annotations: Object.entries(annotations).filter(([, v]) => v).map(([k]) => k),
    testInstructions,
  };
}

// ─────────────────────────────────────────────────────────
// FINAL STEP: Targeted Metadata Fetch & Assembly
// ─────────────────────────────────────────────────────────

async function fetchTargetedMetadata(conn, objectFieldsMap) {
  const objectsMetadata = {};

  for (const [objectName, usedFieldNames] of objectFieldsMap) {
    try {
      const describeResult = await conn.sobject(objectName).describe();
      // 1. Build lookup maps from describe fields
      const allFieldsMap = new Map();
      const relationshipMap = new Map();
      for (const field of describeResult.fields) {
        allFieldsMap.set(field.name.toLowerCase(), field);
        if (field.relationshipName) {
          relationshipMap.set(field.relationshipName.toLowerCase(), field);
        }
      }

      // Helper to resolve any raw field name to the real schema field
      function resolveField(raw) {
        if (!raw) return null;
        const low = raw.trim().toLowerCase();
        // Exact name match (e.g. "casenumber", "id", "status")
        if (allFieldsMap.has(low)) return allFieldsMap.get(low);
        // Relationship match (e.g. "account" -> AccountId, "recordtype" -> RecordTypeId, "owner" -> OwnerId)
        if (relationshipMap.has(low)) return relationshipMap.get(low);
        // Custom relationship "__r" -> "__c" (e.g. "day_visit_plan__r" -> Day_Visit_Plan__c)
        if (low.endsWith('__r')) {
          const customName = low.slice(0, -3) + '__c';
          if (allFieldsMap.has(customName)) return allFieldsMap.get(customName);
        }
        // Standard relationship missing "id" (e.g. "contact" -> ContactId, "createdby" -> CreatedById, "parent" -> ParentId)
        if (!low.endsWith('id')) {
          if (allFieldsMap.has(low + 'id')) return allFieldsMap.get(low + 'id');
        }
        return null;
      }

      const relevantFields = new Set();
      const requiredFields = [];
      const lookupFields = [];
      const missingCustomFields = [];

      for (const rawField of usedFieldNames) {
        const field = resolveField(rawField);
        if (field) {
          relevantFields.add(field.name);
        } else if (rawField.toLowerCase().endsWith('__c')) {
          // Custom field referenced in code but missing from describe (user profile has no FLS/read access)
          missingCustomFields.push(rawField);
        }
      }

      // Add required fields & references
      for (const field of describeResult.fields) {
        if (!field.nillable && field.createable && !field.defaultedOnCreate) {
          relevantFields.add(field.name);
          requiredFields.push(field.name);
        }

        if (field.type === 'reference' && relevantFields.has(field.name)) {
          lookupFields.push({
            field: field.name,
            referenceTo: field.referenceTo || [],
          });
        }
      }

      const fieldMetadata = {};
      for (const fieldName of relevantFields) {
        const field = allFieldsMap.get(fieldName.toLowerCase());
        if (field) {
          const isAccessible = field.accessible !== undefined ? !!field.accessible : true;
          const meta = {
            type: field.type,
            length: field.length || null,
            required: !field.nillable && field.createable,
            accessible: isAccessible,
            createable: !!field.createable,
            updateable: !!field.updateable,
            formula: field.calculated || false,
            autoNumber: field.autoNumber || false,
            defaultedOnCreate: field.defaultedOnCreate || false,
            externalId: field.externalId || false,
          };

          if (field.type === 'picklist' || field.type === 'multipicklist') {
            meta.picklistValues = (field.picklistValues || [])
              .filter((p) => p.active)
              .map((p) => p.value);
          }

          if (field.type === 'reference') {
            meta.referenceTo = field.referenceTo || [];
            meta.relationshipName = field.relationshipName || null;
          }

          fieldMetadata[fieldName] = meta;
        }
      }

      const recordTypes = (describeResult.recordTypeInfos || [])
        .filter((rt) => rt.available && rt.name !== 'Master')
        .map((rt) => ({
          name: rt.name,
          recordTypeId: rt.recordTypeId,
          defaultRecordTypeMapping: rt.defaultRecordTypeMapping,
        }));

      // ── FLS Summary ─────────────────────────────────────
      const flsSummary = {
        fullAccess: [],   // accessible + createable
        readOnly: [],     // accessible but NOT createable (formula, auto-number, system, or FLS-restricted create)
        noAccess: [],     // NOT accessible — user needs a permission set
      };

      for (const rawField of missingCustomFields) {
        flsSummary.noAccess.push({
          field: rawField,
          label: rawField,
          type: 'Custom Field',
          accessible: false,
          createable: false,
          updateable: false,
          formula: false,
          autoNumber: false,
          defaultedOnCreate: false,
          reason: 'Custom field hidden from schema — user profile/permission set has no Read access',
        });
      }

      for (const fieldName of relevantFields) {
        const field = allFieldsMap.get(fieldName.toLowerCase());
        if (!field) continue;

        const isAccessible = field.accessible !== undefined ? !!field.accessible : true;
        const isCreateable = !!field.createable;
        const isUpdateable = !!field.updateable;
        const isSystemField = ['id', 'isdeleted', 'createddate', 'createdbyid', 'lastmodifieddate', 'lastmodifiedbyid', 'systemmodstamp'].includes(field.name.toLowerCase());

        const entry = {
          field: field.name,
          label: field.label || field.name,
          type: field.type,
          accessible: isAccessible,
          createable: isCreateable,
          updateable: isUpdateable,
          formula: !!field.calculated,
          autoNumber: !!field.autoNumber,
          defaultedOnCreate: !!field.defaultedOnCreate,
        };

        if (!isAccessible) {
          entry.reason = 'Field is not accessible — check FLS / Permission Set';
          flsSummary.noAccess.push(entry);
        } else if (!isCreateable) {
          if (field.name.toLowerCase() === 'id') {
            entry.reason = 'System Record ID (assigned automatically on insert)';
          } else if (field.calculated) {
            entry.reason = 'Formula field (calculated automatically by Salesforce)';
          } else if (field.autoNumber) {
            entry.reason = 'Auto-number field (generated automatically by Salesforce)';
          } else if (isSystemField) {
            entry.reason = 'System audit field (read-only)';
          } else {
            entry.reason = 'Read-only field (cannot be created via DML)';
          }
          flsSummary.readOnly.push(entry);
        } else {
          entry.reason = 'Full read & create access for test data';
          flsSummary.fullAccess.push(entry);
        }
      }

      objectsMetadata[objectName] = {
        accessible: describeResult.queryable,
        createable: describeResult.createable,
        updateable: describeResult.updateable,
        deletable: describeResult.deletable,
        usedFields: Array.from(relevantFields),
        requiredFields,
        lookupFields,
        fieldMetadata,
        recordTypes,
        flsSummary,
      };
    } catch (err) {
      console.warn(`[DependencyAnalyzer] Could not describe ${objectName}:`, err.message);
    }
  }

  return objectsMetadata;
}

function resolveInsertionOrder(objectsMetadata) {
  const graph = new Map();
  const allObjects = Object.keys(objectsMetadata);

  for (const objName of allObjects) {
    graph.set(objName, new Set());
    const meta = objectsMetadata[objName];
    for (const lookup of (meta.lookupFields || [])) {
      for (const refTo of (lookup.referenceTo || [])) {
        if (allObjects.includes(refTo) && refTo !== objName) {
          graph.get(objName).add(refTo);
        }
      }
    }
  }

  const inDegree = new Map();
  for (const obj of allObjects) inDegree.set(obj, 0);
  for (const [obj, deps] of graph) {
    inDegree.set(obj, deps.size);
  }

  const queue = [];
  for (const [obj, deg] of inDegree) {
    if (deg === 0) queue.push(obj);
  }

  const sorted = [];
  while (queue.length > 0) {
    const current = queue.shift();
    sorted.push(current);
    for (const [obj, deps] of graph) {
      if (deps.has(current)) {
        deps.delete(current);
        inDegree.set(obj, inDegree.get(obj) - 1);
        if (inDegree.get(obj) === 0) {
          queue.push(obj);
        }
      }
    }
  }

  for (const obj of allObjects) {
    if (!sorted.includes(obj)) sorted.push(obj);
  }

  return sorted;
}

// ─────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────

async function analyzeClassDependencies(conn, apexBody, symbolTable, className) {
  console.log('[DependencyAnalyzer] Starting analysis with SObject verification...');

  // Step 0: Get org's real SObjects & inner classes in this Apex file
  const [validSObjects] = await Promise.all([
    getOrgSObjects(conn),
  ]);
  const innerClasses = extractInnerClassNames(apexBody);

  console.log(`[DependencyAnalyzer] Found ${innerClasses.size} inner classes (ignoring):`, Array.from(innerClasses).join(', '));

  // Layer 1: SOQL
  const soqlFields = extractFieldsFromSOQL(apexBody, validSObjects);

  // Layer 2: DML & Code (strictly real SObjects only)
  const codeFields = extractFieldsFromCode(apexBody, validSObjects, innerClasses);

  // Layer 3: SymbolTable
  const symbolFields = extractFieldsFromSymbolTable(symbolTable, validSObjects);

  // Merge verified SObjects
  const mergedFields = new Map();
  for (const source of [soqlFields, codeFields, symbolFields]) {
    for (const [objName, fields] of source) {
      if (validSObjects.has(objName.toLowerCase())) {
        const realName = validSObjects.get(objName.toLowerCase());
        if (!mergedFields.has(realName)) {
          mergedFields.set(realName, new Set());
        }
        for (const f of fields) {
          mergedFields.get(realName).add(f);
        }
      }
    }
  }

  console.log(`[DependencyAnalyzer] Verified ${mergedFields.size} real SObjects:`, Array.from(mergedFields.keys()).join(', '));

  // Fetch targeted metadata for real SObjects only
  const objectsMetadata = await fetchTargetedMetadata(conn, mergedFields);
  const realSObjectNames = Object.keys(objectsMetadata);

  // Layer 4: Org Metadata on real SObjects
  const [validationRules, recordTriggeredFlows, apexTriggers] = await Promise.all([
    fetchValidationRules(conn, realSObjectNames),
    fetchRecordTriggeredFlows(conn, realSObjectNames),
    fetchApexTriggers(conn, realSObjectNames, className),
  ]);

  for (const objName of realSObjectNames) {
    if (objectsMetadata[objName]) {
      objectsMetadata[objName].validationRules = validationRules.get(objName) || [];
      objectsMetadata[objName].recordTriggeredFlows = recordTriggeredFlows.get(objName) || [];
      objectsMetadata[objName].triggers = apexTriggers.get(objName) || [];
    }
  }

  const customSettings = detectCustomSettingsAndMetadata(apexBody);
  const sharingModel = detectSharingModel(apexBody);
  const insertionOrder = resolveInsertionOrder(objectsMetadata);

  // Layer 5: Class-level pattern detection
  const calloutInfo = detectCalloutPatterns(apexBody);
  const interfaceInfo = detectClassInterfaces(apexBody);
  const annotationInfo = detectClassAnnotations(apexBody);

  if (calloutInfo.hasCallout) {
    console.log(`[DependencyAnalyzer] Callout patterns detected: ${calloutInfo.patterns.join(', ')}`);
  }
  if (interfaceInfo.interfaces.length > 0) {
    console.log(`[DependencyAnalyzer] Class interfaces: ${interfaceInfo.interfaces.join(', ')}`);
  }
  if (annotationInfo.annotations.length > 0) {
    console.log(`[DependencyAnalyzer] Class annotations: ${annotationInfo.annotations.join(', ')}`);
  }

  const report = {
    objects: objectsMetadata,
    customSettings,
    sharingModel,
    dependencyGraph: [],
    insertionOrder,
    calloutInfo,
    interfaceInfo,
    annotationInfo,
  };

  console.log('[DependencyAnalyzer] Analysis complete.');
  return report;
}

module.exports = {
  analyzeClassDependencies,
  extractFieldsFromSOQL,
  extractFieldsFromCode,
  extractInnerClassNames,
  detectCustomSettingsAndMetadata,
  detectSharingModel,
  detectCalloutPatterns,
  detectClassInterfaces,
  detectClassAnnotations,
  resolveInsertionOrder,
};

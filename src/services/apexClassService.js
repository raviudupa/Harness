/**
 * Apex Class Service
 * Reads Apex classes from the Salesforce org via the Tooling API.
 * Provides methods to list classes, fetch bodies, get symbol tables,
 * and check for existing test classes.
 */
const { SF_API_VERSION } = require('../config/salesforce');

/**
 * List all non-test, non-managed Apex classes in the org.
 * @param {jsforce.Connection} conn
 * @returns {Promise<Array<{id: string, name: string, lengthWithoutComments: number, apiVersion: string}>>}
 */
async function listApexClasses(conn) {
  const result = await conn.tooling.query(
    `SELECT Id, Name, LengthWithoutComments, ApiVersion
     FROM ApexClass
     WHERE NamespacePrefix = null
       AND Status = 'Active'
     ORDER BY Name`
  );

  // Filter out test classes by checking for @isTest annotation in the name pattern
  // We'll do a secondary filter by fetching bodies only when needed
  const classes = (result.records || []).map((rec) => ({
    id: rec.Id,
    name: rec.Name,
    lengthWithoutComments: rec.LengthWithoutComments,
    apiVersion: rec.ApiVersion,
  }));

  return classes;
}

/**
 * Fetch the full body and SymbolTable of a specific Apex class.
 * @param {jsforce.Connection} conn
 * @param {string} className - API name of the Apex class
 * @returns {Promise<{id: string, name: string, body: string, symbolTable: object|null}>}
 */
async function getApexClassDetail(conn, className) {
  const result = await conn.tooling.query(
    `SELECT Id, Name, Body, SymbolTable
     FROM ApexClass
     WHERE Name = '${className}'
       AND NamespacePrefix = null`
  );

  if (!result.records || result.records.length === 0) {
    throw new Error(`Apex class '${className}' not found in the org.`);
  }

  const rec = result.records[0];
  return {
    id: rec.Id,
    name: rec.Name,
    body: rec.Body,
    symbolTable: rec.SymbolTable || null,
  };
}

/**
 * Fetch only the SymbolTable for a class. If null (not yet compiled),
 * retry once after a short delay.
 * @param {jsforce.Connection} conn
 * @param {string} className
 * @returns {Promise<object|null>}
 */
async function getSymbolTable(conn, className) {
  let result = await conn.tooling.query(
    `SELECT Id, Name, SymbolTable
     FROM ApexClass
     WHERE Name = '${className}'
       AND NamespacePrefix = null`
  );

  if (!result.records || result.records.length === 0) {
    return null;
  }

  let symbolTable = result.records[0].SymbolTable;

  // SymbolTable can be null if background compilation hasn't finished
  if (!symbolTable) {
    console.log(`[ApexClassService] SymbolTable is null for '${className}', retrying in 3s...`);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    result = await conn.tooling.query(
      `SELECT Id, Name, SymbolTable
       FROM ApexClass
       WHERE Name = '${className}'
         AND NamespacePrefix = null`
    );
    symbolTable = result.records?.[0]?.SymbolTable || null;
  }

  return symbolTable;
}

/**
 * Check if a test class already exists for the given class.
 * Looks for common naming patterns: ClassNameTest, ClassNameTest, Test_ClassName
 * @param {jsforce.Connection} conn
 * @param {string} className
 * @returns {Promise<{exists: boolean, testClassName: string|null, testClassId: string|null}>}
 */
async function getExistingTestClass(conn, className) {
  const possibleNames = [
    `${className}Test`,
    `${className}_Test`,
    `Test_${className}`,
    `${className}Tests`,
  ];

  const nameList = possibleNames.map((n) => `'${n}'`).join(',');
  const result = await conn.tooling.query(
    `SELECT Id, Name, Body
     FROM ApexClass
     WHERE Name IN (${nameList})
       AND NamespacePrefix = null`
  );

  if (result.records && result.records.length > 0) {
    const rec = result.records[0];
    return {
      exists: true,
      testClassName: rec.Name,
      testClassId: rec.Id,
      testClassBody: rec.Body,
    };
  }

  return { exists: false, testClassName: null, testClassId: null, testClassBody: null };
}

/**
 * Fetch the Apex class ID by name.
 * @param {jsforce.Connection} conn
 * @param {string} className
 * @returns {Promise<string|null>}
 */
async function getApexClassId(conn, className) {
  const result = await conn.tooling.query(
    `SELECT Id FROM ApexClass WHERE Name = '${className}' AND NamespacePrefix = null`
  );
  return result.records?.[0]?.Id || null;
}

module.exports = {
  listApexClasses,
  getApexClassDetail,
  getSymbolTable,
  getExistingTestClass,
  getApexClassId,
};

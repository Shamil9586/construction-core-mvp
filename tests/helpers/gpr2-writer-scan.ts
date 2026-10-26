import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * GPR-2 R03b — finds every code path in apps/backend/src that writes to the database, with the TypeScript compiler (not a regex over text),
 * so the writer register (apps/backend/src/writer-registry.ts) can be proved complete. Used by tests only.
 *
 * A "writer site" is
 *   TX         a call to `transaction(…)`, `<x>.transaction(…)`, `runCommandTx(…)` or the FIN restricted-pool `runFinSdoCommandTx(…)` — every code path that opens a write transaction
 *   POOLWRITE  a write issued straight on the shared pool: pool.query('INSERT …'), insert(pool, …), one/rows(pool, 'UPDATE …')
 * Each is keyed `<file under apps/backend/src>#<enclosing method or function name>`.
 */
export interface WriterSite {
    key: string;
    kind: 'TX' | 'POOLWRITE';
    file: string;
    method: string;
    /** TX only: the callback passed to the transaction call, when it is an inline function. */
    callback: ts.ArrowFunction | ts.FunctionExpression | null;
    line: number;
}

const WRITE_SQL = /\b(INSERT\s+INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM)\b/i;

export function walkTs(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory())
            out.push(...walkTs(p));
        else if (p.endsWith('.ts'))
            out.push(p);
    }
    return out.sort();
}

export function scanSource(relFile: string, text: string): WriterSite[] {
    const sf = ts.createSourceFile(relFile, text, ts.ScriptTarget.Latest, true);
    const sites: WriterSite[] = [];
    const enclosing = (n: ts.Node): string => {
        for (let p = n.parent; p; p = p.parent)
            if ((ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) && p.name)
                return p.name.getText();
        return '<top>';
    };
    const add = (n: ts.CallExpression, kind: WriterSite['kind'], callback: WriterSite['callback']) => {
        const method = enclosing(n);
        sites.push({ key: relFile + '#' + method, kind, file: relFile, method, callback, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1 });
    };
    const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n)) {
            const callee = n.expression.getText();
            const first = n.arguments[0];
            if (callee === 'transaction' || callee.endsWith('.transaction') || callee === 'runCommandTx' || callee === 'runFinSdoCommandTx') {
                const cb = n.arguments.find(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a)) as WriterSite['callback'] | undefined;
                add(n, 'TX', cb ?? null);
            }
            else if (callee === 'pool.query' && first && WRITE_SQL.test(first.getText()))
                add(n, 'POOLWRITE', null);
            else if (/^(insert|insertIdempotent|audit)$/.test(callee) && first?.getText() === 'pool')
                add(n, 'POOLWRITE', null);
            else if (/^(one|rows)$/.test(callee) && first?.getText() === 'pool' && n.arguments[1] && WRITE_SQL.test(n.arguments[1].getText()))
                add(n, 'POOLWRITE', null);
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return sites;
}

export function scanBackend(root = 'apps/backend/src'): WriterSite[] {
    return walkTs(root).flatMap(f => scanSource(path.relative(root, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')));
}

/** Is the first statement of `cb` exactly `await coordinate(<anything>, '<id>', …)`? */
export function firstStatementCoordinates(cb: NonNullable<WriterSite['callback']>, id: string): boolean {
    const body = cb.body;
    if (!ts.isBlock(body) || !body.statements.length)
        return false;
    const s = body.statements[0];
    if (!ts.isExpressionStatement(s) || !ts.isAwaitExpression(s.expression) || !ts.isCallExpression(s.expression.expression))
        return false;
    const call = s.expression.expression;
    if (call.expression.getText() !== 'coordinate')
        return false;
    const arg = call.arguments[1];
    return !!arg && ts.isStringLiteral(arg) && arg.text === id;
}

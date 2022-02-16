import {
    Evaluate,
    Func,
    KeyValuate,
    transform,
    ValueOf,
    Exact,
    toString,
    DeepTreeOf
} from "@re-/tools"
import { SpaceResolutions } from "../compile"
import { ValidationErrors, unknownTypeError } from "../errors.js"
import { ExtractableDefinition } from "./internal.js"
import { Root } from "./root.js"
import { Obj } from "./obj"
import { GenerateOptions, ReferencesOptions } from "../model.js"

export type MatchesArgs<DefType> = {
    definition: DefType
    space: SpaceResolutions
}

export type AllowsOptions = {
    ignoreExtraneousKeys?: boolean
}

export type ParseContext = {
    space: SpaceResolutions
    path: string[]
    seen: string[]
    shallowSeen: string[]
}

export const defaultParseContext: ParseContext = {
    space: {},
    path: [],
    seen: [],
    shallowSeen: []
}

export type ParseArgs<DefType> = [definition: DefType, context: ParseContext]

export type ParserInput<
    DefType,
    Parent,
    Children extends DefType[],
    Components
> = {
    type: DefType
    parent: () => Parent
    components?: (...args: ParseArgs<DefType>) => Components
    children?: () => Children
    // What to do if no children match (defaults to throwing unparsable error)
    fallback?: (...args: ParseArgs<DefType>) => any
}

export type DefinitionMatcher<Parent> = (
    definition: KeyValuate<Parent, "type">,
    context: ParseContext
) => boolean

export type MethodsArg<Children, Methods> = Children extends never[]
    ? [methods: Required<Methods>]
    : [methods?: Methods]

export type InheritableMethodContext<DefType, Components> = [
    args: {
        def: DefType
        ctx: ParseContext
    } & (unknown extends Components ? {} : { components: Components })
]

export type InheritableMethods<DefType, Components> = {
    allows?: (
        ...args: [
            ...args: InheritableMethodContext<DefType, Components>,
            valueType: ExtractableDefinition,
            options: AllowsOptions
        ]
    ) => ValidationErrors
    references?: (
        ...args: [
            ...args: InheritableMethodContext<DefType, Components>,
            options: ReferencesOptions
        ]
    ) => DefType extends Obj.Definition ? DeepTreeOf<string[]> : string[]
    generate?: (
        ...args: [
            ...args: InheritableMethodContext<DefType, Components>,
            options: GenerateOptions
        ]
    ) => any
}

export type MethodsInput<DefType, Parent, Components> = Omit<
    InheritableMethods<DefType, Components>,
    keyof GetHandledMethods<Parent>
> & { matches?: DefinitionMatcher<Parent> }

export type ParseFunction<DefType> = (
    ...args: ParseArgs<DefType>
) => ParseResult<DefType>

export type ParseResult<DefType> = {
    def: DefType
    ctx: ParseContext
} & TransformedInheritableMethods<DefType>

export type TransformedInheritableMethods<DefType> = {
    [MethodName in InheritableMethodName]-?: TransformInputMethod<
        NonNullable<InheritableMethods<DefType, any>[MethodName]>
    >
}

export type TransformInputMethod<
    Method extends ValueOf<InheritableMethods<any, any>>
> = Method extends (
    ...args: [infer ParseResult, ...infer Rest, infer Opts]
) => infer Return
    ? (...args: [...rest: Rest, opts?: Opts]) => Return
    : Method

export type GetHandledMethods<Parent> = (KeyValuate<
    Parent,
    "inherits"
> extends () => infer Return
    ? Return
    : {}) &
    KeyValuate<Parent, "handles">

export type ParserMetadata<DefType, Parent, Handles> = Evaluate<{
    type: DefType
    inherits: () => GetHandledMethods<Parent>
    handles: unknown extends Handles ? {} : Handles
    matches: (def: DefType, ctx?: ParseContext) => boolean
}>

export type Parser<DefType, Parent, Methods> = Evaluate<
    ParserMetadata<DefType, Parent, Methods> & ParseFunction<DefType>
>

export type InheritableMethodName = keyof InheritableMethods<any, any>

const inheritableMethodNames = [
    "allows",
    "references",
    "generate"
] as InheritableMethodName[]

// Re:Root, reroot its root by rerouting to reroot
export const reroot = {
    type: {} as Root.Definition,
    inherits: () => {},
    handles: {},
    matches: () => true
}

type AnyMethodsInput = Record<InheritableMethodName | "matches", any>
type AnyParser = Parser<any, any, any>

export const createParser = <
    Input,
    Methods,
    DefType,
    Parent,
    Components,
    Children extends DefType[] = []
>(
    ...args: [
        Exact<Input, ParserInput<DefType, Parent, Children, Components>>,
        ...MethodsArg<
            Children,
            Exact<Methods, MethodsInput<DefType, Parent, Components>>
        >
    ]
): Parser<DefType, Parent, Methods> => {
    const input = args[0] as ParserInput<DefType, Parent, Children, Components>
    const methods = ((args[1] as any) ?? {}) as AnyMethodsInput
    // Need to wait until parse is called to access parent to avoid it being undefined
    // due to circular import
    const getInherited = () => {
        const parent = input.parent() as any as ParserMetadata<any, any, any>
        return {
            ...parent.inherits(),
            ...parent.handles
        } as InheritableMethods<DefType, Components>
    }
    const getChildren = (): AnyParser[] => (input.children?.() as any) ?? []
    const cachedComponents: Record<string, any> = {}
    const getComponents = (def: DefType, ctx: ParseContext) => {
        const memoKey = toString({
            def,
            space: ctx.space,
            shallowSeen: ctx.shallowSeen,
            seen: ctx.seen,
            path: ctx.path
        })
        if (!cachedComponents[memoKey]) {
            cachedComponents[memoKey] =
                input.components?.(def, ctx) ?? undefined
        }
        return cachedComponents[memoKey]
    }
    const transformInheritableMethod =
        (
            name: InheritableMethodName,
            inputMethod: Func,
            def: DefType,
            ctx: ParseContext,
            components: Components
        ) =>
        (
            ...providedArgs: Parameters<
                ValueOf<TransformedInheritableMethods<DefType>>
            >
        ) => {
            if (name === "allows") {
                return inputMethod(
                    {
                        def,
                        ctx,
                        components
                    },
                    providedArgs[0],
                    providedArgs[1] ?? {}
                )
            }
            return inputMethod(
                {
                    def,
                    ctx,
                    components
                },
                providedArgs[0] ?? {}
            )
        }

    const delegateMethod = (
        methodName: InheritableMethodName | "matches",
        def: DefType,
        ctx: ParseContext
    ) => {
        const children = getChildren()
        if (!children.length) {
            throw new Error(
                `${methodName} was never implemented on the current component's branch.`
            )
        }
        const match = children.find((child) => child.matches(def, ctx))
        if (methodName === "matches") {
            return () => !!match
        }
        if (!match) {
            if (input.fallback) {
                return input.fallback(def, ctx)
            }
            throw new Error(unknownTypeError(def, ctx.path))
        }
        return match(def, ctx)[methodName]
    }
    const getInheritableMethods = (
        def: DefType,
        ctx: ParseContext,
        components: any
    ) => {
        return transform(inheritableMethodNames, ([i, methodName]) => {
            const inherited = getInherited()
            if (methods[methodName]) {
                return [
                    methodName,
                    transformInheritableMethod(
                        methodName,
                        methods[methodName]!,
                        def,
                        ctx,
                        components
                    )
                ]
            } else if (inherited[methodName]) {
                return [
                    methodName,
                    transformInheritableMethod(
                        methodName,
                        inherited[methodName]!,
                        def,
                        ctx,
                        components
                    )
                ]
            } else {
                return [methodName, delegateMethod(methodName, def, ctx)]
            }
        }) as TransformedInheritableMethods<DefType>
    }
    const parse = (def: DefType, ctx: ParseContext): ParseResult<DefType> => {
        const components = getComponents(def, ctx)
        return {
            def,
            ctx,
            ...getInheritableMethods(def, ctx, components)
        }
    }
    return Object.assign(parse, {
        type: input.type,
        inherits: getInherited,
        handles: transform(methods, ([name, def]) =>
            inheritableMethodNames.includes(name as any) ? [name, def] : null
        ),
        matches: (...args: Parameters<DefinitionMatcher<Parent>>) => {
            const [def, ctx] = args
            if (methods.matches) {
                return methods.matches(def, ctx)
            }
            return delegateMethod(
                "matches",
                def as any,
                ctx ?? defaultParseContext
            )()
        }
    }) as any
}
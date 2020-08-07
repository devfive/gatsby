import React, { Suspense, useContext, useState } from "react"
import Queue from "better-queue"
import lodash from "lodash"
import mitt from "mitt"

import resources from "../resources"

import RecipesReconciler from "./reconciler"
import ErrorBoundary from "./error-boundary"
import transformToPlan from "./transform-to-plan-structure"
import {
  ParentResourceProvider,
  useParentResourceContext,
} from "./parent-resource-provider"
import { useRecipeStep } from "./step-component"
import { InputProvider } from "./input-provider"
import { ResourceProvider, useResourceContext } from "./resource-provider"

const queue = new Queue(
  async (job, cb) => {
    const result = await job
    cb(null, result)
  },
  { concurrent: 5 }
)

const resultCache = new Map()
const inFlightCache = new Map()

const ModeContext = React.createContext({})
const useMode = () => useContext(ModeContext)
const ModeProvider = ModeContext.Provider

const getUserProps = props => {
  // eslint-disable-next-line
  const { mdxType, children, ...userProps } = props
  return userProps
}

const SetResourcesProvider = React.createContext()

let resourcesCache

const Wrapper = ({ children, inputs, isApply }) => {
  // eslint-disable-next-line
  const [resourcesList, setResources] = useState(resourcesCache || [])
  resourcesCache = resourcesList

  return (
    <ErrorBoundary>
      <ModeProvider value={{ mode: isApply ? `apply` : `plan` }}>
        <SetResourcesProvider.Provider value={setResources}>
          <ResourceProvider value={resourcesList}>
            <InputProvider value={inputs}>
              <Suspense fallback={<p>Loading recipe...</p>}>
                {children}
              </Suspense>
            </InputProvider>
          </ResourceProvider>
        </SetResourcesProvider.Provider>
      </ModeProvider>
    </ErrorBoundary>
  )
}

const ResourceComponent = ({
  _resourceName: Resource,
  _uuid,
  _type,
  children,
  ...props
}) => {
  const { mode } = useMode()
  const step = useRecipeStep()
  const parentResourceContext = useParentResourceContext()

  // TODO add provider onto context
  const resourceData = handleResource(
    Resource,
    {
      ...parentResourceContext,
      root: process.cwd(),
      _uuid,
      mode,
    },
    props
  )

  return (
    <ParentResourceProvider data={{ [Resource]: resourceData }}>
      <Resource>
        {JSON.stringify({
          ...resourceData,
          _props: props,
          _stepMetadata: step,
          _uuid,
          _type,
        })}
        {children}
      </Resource>
    </ParentResourceProvider>
  )
}

const validateResource = (resourceName, context, props) => {
  const userProps = getUserProps(props)
  const { error } = resources[resourceName].validate(userProps)
  if (error) {
    error.resourceUuid = context._uuid
  }
  return error
}

const handleResource = (resourceName, context, props) => {
  // Initialize
  const { mode } = context

  const trueKey = props._key ? props._key : context._uuid

  let cacheKey
  // Only run apply once per resource
  if (mode === `apply`) {
    cacheKey = mode + ` ` + resourceName + ` ` + trueKey
  } else {
    cacheKey = JSON.stringify({ resourceName, ...props, mode })
  }

  // update global context when results come in.
  const updateResource = result => {
    allResources = allResources.filter(a => a.resourceDefinitions._key)
    const resourceMap = new Map()

    allResources.forEach(r => resourceMap.set(r.resourceDefinitions._key, r))
    const newResource = {
      resourceName,
      resourceDefinitions: props,
      ...result,
    }

    if (!lodash.isEqual(newResource, resourceMap.get(trueKey))) {
      resourceMap.set(trueKey, newResource)
      // TODO Do we need this? It's causing infinite loops
      // setResources([...resourceMap.values()])
    }
  }

  let allResources = useResourceContext()
  const error = validateResource(resourceName, context, props)
  if (error) {
    const result = {
      error: `Validation error: ${error.details[0].message}`,
    }
    updateResource(result)
    resultCache.set(cacheKey, result)
    return result
  }

  const cachedResult = resultCache.get(cacheKey)
  const inFlightPromise = inFlightCache.get(cacheKey)

  if (cachedResult) {
    updateResource(cachedResult)
    return cachedResult
  }

  if (inFlightPromise) {
    throw inFlightPromise
  }

  const fn = mode === `apply` ? `create` : `plan`

  let promise
  try {
    promise = new Promise((resolve, reject) => {
      // Multiple of the same promises can be queued due to re-rendering
      // so this first checks for the cached result again before executing
      // the request.
      const cachedValue = resultCache.get(cacheKey)
      if (cachedValue) {
        resolve(cachedValue)
        updateResource(cachedValue)
      } else {
        resources[resourceName][fn](context, props)
          .then(result => {
            if (fn === `create`) {
              result.isDone = true
            }
            updateResource(result)
            inFlightCache.set(cacheKey, false)
            return result
          })
          .then(result => {
            resultCache.set(cacheKey, result)
            return result
          })
          .then(resolve)
          .catch(e => {
            if (e.name === `MissingInfoError`) {
              inFlightCache.delete(cacheKey)
            }
            reject(e)
          })
      }
    })
  } catch (e) {
    throw e
  }

  inFlightCache.set(cacheKey, promise)

  queue.push(promise)

  throw promise
}

const render = (recipe, cb, inputs = {}, isApply) => {
  const emitter = mitt()
  const plan = {}

  let result

  const recipeWithWrapper = (
    <Wrapper inputs={inputs} isApply={isApply}>
      {recipe}
    </Wrapper>
  )

  // Keep calling render until there's remaining resources to render.
  // This let's resources that depend on other resources to pause until one finishes.
  const renderResources = () => {
    result = RecipesReconciler.render(recipeWithWrapper, plan)

    // If there's still nothing on the queue that means we're done.
    if (queue.length === 0) {
      // Rerender with the resources and resolve the data from the cache
      result = RecipesReconciler.render(recipeWithWrapper, plan)
      const resources = transformToPlan(result)
      emitter.emit(`done`, resources)
    }
  }

  const throttledRenderResources = lodash.throttle(renderResources, 30, {
    trailing: false,
  })

  queue.on(`task_finish`, function (taskId, r, stats) {
    throttledRenderResources()

    const resources = transformToPlan(result)
    emitter.emit(`update`, resources)
  })

  queue.on(`drain`, () => {
    renderResources()
  })

  renderResources()

  return emitter
}

module.exports.render = render
module.exports.ResourceComponent = ResourceComponent

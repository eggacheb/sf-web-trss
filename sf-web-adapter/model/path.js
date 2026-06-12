import path from 'path'
import { fileURLToPath } from 'url'

const _path = process.cwd().replace(/\\/g, '/')
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginName = path.basename(pluginRoot)
const pluginResources = path.join(pluginRoot, 'resources')

export { _path, pluginName, pluginRoot, pluginResources }

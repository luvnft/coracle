import {collection} from "src/engine/core/utils"
import type {List} from "./model"

export const lists = collection<List>("naddr")

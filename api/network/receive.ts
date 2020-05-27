import * as path from 'path'
import * as lndService from '../grpc'
import {getInfo} from '../utils/lightning'
import {ACTIONS} from '../controllers'
import * as tribes from '../utils/tribes'
import {SPHINX_CUSTOM_RECORD_KEY, verifyAscii} from '../utils/lightning'
import { models } from '../models'
import {sendMessage} from './send'
import {modifyPayload} from './modify'
import {decryptMessage,encryptTribeBroadcast} from '../utils/msg'

const constants = require(path.join(__dirname,'../../config/constants.json'))
const msgtypes = constants.message_types

const typesToForward=[
	msgtypes.message, msgtypes.group_join, msgtypes.group_leave, msgtypes.attachment
]
const typesToModify=[
	msgtypes.attachment
]
const typesThatNeedPricePerMessage = [
	msgtypes.message, msgtypes.attachment
]
async function onReceive(payload){
	// if tribe, owner must forward to MQTT
	let doAction = true
	const toAddIn:{[k:string]:any} = {}
	const isTribe = payload.chat && payload.chat.type===constants.chat_types.tribe
	if(isTribe && typesToForward.includes(payload.type)){
		const needsPricePerJoin = typesThatNeedPricePerMessage.includes(payload.type)
		const chat = await models.Chat.findOne({where:{uuid:payload.chat.uuid}})
		const tribeOwnerPubKey = chat && chat.ownerPubkey
		const owner = await models.Contact.findOne({where: {isOwner:true}})
		if(owner.publicKey===tribeOwnerPubKey){
			toAddIn.isTribeOwner = true
			// CHECK THEY ARE IN THE GROUP if message
			if(needsPricePerJoin) {
				const senderContact = await models.Contact.findOne({where:{publicKey:payload.sender.pub_key}})
				const senderMember = senderContact && await models.ChatMember.findOne({where:{contactId:senderContact.id, chatId:chat.id}})
				if(!senderMember) doAction=false
			}
			// CHECK PRICES
			if(needsPricePerJoin) {
				if(payload.message.amount<chat.pricePerMessage) doAction=false
			}
			// check price to join
			if(payload.type===msgtypes.group_join) {
				if(payload.message.amount<chat.priceToJoin) doAction=false
			}
			if(doAction) forwardMessageToTribe(payload)
			else console.log('=> insufficient payment for this action')
		}
	}
	if(doAction) doTheAction({...payload, ...toAddIn})
}

async function doTheAction(data){
	let payload = data
	if(payload.isTribeOwner) {
		const ogContent = data.message && data.message.content
		// decrypt and re-encrypt with self pubkey
		const chat = await models.Chat.findOne({where:{uuid:payload.chat.uuid}})
		const pld = await decryptMessage(data, chat)
		const me = await models.Contact.findOne({where:{isOwner:true}})
		payload = await encryptTribeBroadcast(pld, me, true) // true=isTribeOwner
		if(ogContent) payload.message.remoteContent = ogContent
	}
	if(ACTIONS[payload.type]) {
		ACTIONS[payload.type](payload)
	} else {
		console.log('Incorrect payload type:', payload.type)
	}
}

async function forwardMessageToTribe(ogpayload){
	const chat = await models.Chat.findOne({where:{uuid:ogpayload.chat.uuid}})

	let payload
	if(typesToModify.includes(ogpayload.type)){
		payload = await modifyPayload(ogpayload, chat)
	} else {
		payload = ogpayload
	}
	//console.log("FORWARD TO TRIBE",payload) // filter out the sender?
	
	//const sender = await models.Contact.findOne({where:{publicKey:payload.sender.pub_key}})
	const owner = await models.Contact.findOne({where:{isOwner:true}})
	const type = payload.type
	const message = payload.message
	// HERE: NEED TO MAKE SURE ALIAS IS UNIQUE
	// ASK xref TABLE and put alias there too?
	sendMessage({
		sender: {
			...owner.dataValues,
			...payload.sender&&payload.sender.alias && {alias:payload.sender.alias}
		},
		chat, type, message,
		skipPubKey: payload.sender.pub_key, 
		success: ()=>{},
		receive: ()=>{}
	})
}

export async function initGrpcSubscriptions() {
	try{
		await getInfo()
		await lndService.subscribeInvoices(parseKeysendInvoice)
	} catch(e) {
		throw e
	}
}

export async function initTribesSubscriptions(){
	tribes.connect(async(topic, message)=>{ // onMessage callback
		try{
			const msg = message.toString()
			console.log("=====> msg received! TOPIC", topic, "MESSAGE", msg)
			// check topic is signed by sender?
			const payload = await parseAndVerifyPayload(msg)
			onReceive(payload)
		} catch(e){}
    })
}

// VERIFY PUBKEY OF SENDER from sig
async function parseAndVerifyPayload(data){
	let payload
	const li = data.lastIndexOf('}')
	const msg = data.substring(0,li+1)
	const sig = data.substring(li+1)
	try {
		payload = JSON.parse(msg)
		if(payload) {
			const v = await verifyAscii(msg, sig)
			if(v && v.valid && v.pubkey) {
				payload.sender = payload.sender||{}
				payload.sender.pub_key=v.pubkey
				return payload
			} else {
				return payload // => RM THIS
			}
		}
	} catch(e) {
		if(payload) return payload // => RM THIS
		return null
	}
}

export async function parseKeysendInvoice(i){
	const recs = i.htlcs && i.htlcs[0] && i.htlcs[0].custom_records
	const buf = recs && recs[SPHINX_CUSTOM_RECORD_KEY]
	const data = buf && buf.toString()
	const value = i && i.value && parseInt(i.value)
	if(!data) return

	let payload
	if(data[0]==='{'){
		try {
			payload = await parseAndVerifyPayload(data)
		} catch(e){}
	} else {
		const threads = weave(data)
		if(threads) payload = await parseAndVerifyPayload(threads)
	}
	if(payload){
		const dat = payload
		if(value && dat && dat.message){
			dat.message.amount = value // ADD IN TRUE VALUE
        }
		onReceive(dat)
	}
}

const chunks = {}
function weave(p){
	const pa = p.split('_')
	if(pa.length<4) return
	const ts = pa[0]
	const i = pa[1]
	const n = pa[2]
	const m = pa.filter((u,i)=>i>2).join('_')
	chunks[ts] = chunks[ts] ? [...chunks[ts], {i,n,m}] : [{i,n,m}]
	if(chunks[ts].length===parseInt(n)){
		// got em all!
		const all = chunks[ts]
		let payload = ''
		all.slice().sort((a,b)=>a.i-b.i).forEach(obj=>{
			payload += obj.m
		})
		delete chunks[ts]
		return payload
	}
}

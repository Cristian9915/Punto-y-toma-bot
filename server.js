
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'puntoytoma2026';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1338194502713965';
const MI_NUMERO = process.env.MI_NUMERO_PERSONAL || '5493546455592';

const config = require('./config.json');
const sessions = new Map(); // phone -> {step, servicio, cantidad, altura, zona, presupuesto}

const WHATSAPP_API = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

// --- Helpers para enviar ---
async function send(to, text) {
  try {
    await axios.post(WHATSAPP_API, {
      messaging_product: "whatsapp",
      to,
      text: { body: text }
    }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  } catch(e){ console.log('send error', e.response?.data || e.message); }
}

async function sendButtons(to, body, buttons) {
  // buttons = [{id, title}]
  try {
    await axios.post(WHATSAPP_API, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: { buttons: buttons.map(b=>({type:"reply", reply:{id:b.id, title:b.title}})) }
      }
    }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  } catch(e){ 
    console.log('buttons error', e.response?.data || e.message);
    await send(to, body + "\n\n" + buttons.map(b=>`• ${b.title}`).join("\n"));
  }
}

async function sendList(to, body, buttonText, sections) {
  try {
    await axios.post(WHATSAPP_API, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body },
        action: { button: buttonText, sections }
      }
    }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  } catch(e){
    console.log('list error', e.response?.data);
    let txt = body + "\n\nOpciones:\n";
    sections[0].rows.forEach((r,i)=> txt+= `${i+1}. ${r.title}\n`);
    await send(to, txt);
  }
}

// --- Webhook verification ---
app.get('/webhook', (req,res)=>{
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if(mode==='subscribe' && token===VERIFY_TOKEN){
    console.log('Webhook verificado!');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// --- Webhook mensajes ---
app.post('/webhook', async (req,res)=>{
  try{
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if(!msg) return res.sendStatus(200);
    
    const from = msg.from; // numero cliente
    const type = msg.type;
    let text = '';
    if(type==='text') text = msg.text.body.toLowerCase();
    if(type==='interactive'){
      if(msg.interactive?.button_reply) text = msg.interactive.button_reply.id;
      if(msg.interactive?.list_reply) text = msg.interactive.list_reply.id;
    }
    if(type==='audio' || type==='voice') text = 'audio_otro';

    console.log('Mensaje de', from, ':', text, 'tipo', type);

    let sess = sessions.get(from) || {step:'inicio'};

    // --- FLUJO ---
    if(sess.step==='inicio' || text.includes('hola') || text.includes('menu') || text.includes('inicio')){
      sess = {step:'menu'};
      sessions.set(from, sess);
      await sendList(from, config.mensaje_bienvenida, "Ver opciones", [
        { title:"Servicios Punto y Toma", rows: config.opciones_menu.map(o=>({id:o.id, title:o.titulo, description:o.desc})) }
      ]);
      return res.sendStatus(200);
    }

    // Usuario eligió servicio del menú
    if(sess.step==='menu' && config.precios[text]){
      sess.servicio = text;
      if(text==='otro'){
        sess.step='otro_detalle';
        sessions.set(from, sess);
        await send(from, `Perfecto 👷‍♂️\n\nContame con un *audio o mensaje* qué trabajo necesitas hacer. Detallá lo más que puedas (qué hay que cambiar, dónde, si tenés los materiales, etc.)\n\nYo se lo reenvío a Cristian para que te cotice personalizado.`);
        return res.sendStatus(200);
      }
      sess.step='cantidad';
      sessions.set(from, sess);
      await send(from, `Genial, ${config.precios[text].nombre} 👌\n\n¿Cuántas unidades necesitas? (Ej: 1, 2, 3...)\nEscribí solo el número.`);
      return res.sendStatus(200);
    }

    if(sess.step==='cantidad'){
      let cant = parseInt(text) || 1;
      if(cant<1) cant=1; if(cant>50) cant=50;
      sess.cantidad = cant;
      sess.step='altura';
      sessions.set(from, sess);
      await sendButtons(from, `¿Es en altura? ¿Hay que usar escalera alta (más de 2.5mts)?`, [
        {id:'altura_si', title:'Sí, en altura'},
        {id:'altura_no', title:'No, normal'}
      ]);
      return res.sendStatus(200);
    }

    if(sess.step==='altura'){
      sess.altura = text.includes('si');
      sess.step='zona';
      sessions.set(from, sess);
      await sendButtons(from, `¿Dónde es el trabajo?`, [
        {id:'vgb', title:'VGB'},
        {id:'reartes', title:'Los Reartes'},
        {id:'otra_zona', title:'Otra zona'}
      ]);
      return res.sendStatus(200);
    }

    if(sess.step==='zona'){
      sess.zona = text;
      // CALCULAR PRESUPUESTO
      const p = config.precios[sess.servicio];
      let total = p.base + (p.por_unidad * Math.max(0, sess.cantidad-1));
      if(sess.altura) total += p.altura_extra;
      if(text==='reartes') total += 2000;
      if(text==='otra_zona') total += 3000;
      
      sess.presupuesto = total;
      sess.step='presupuesto';
      sessions.set(from, sess);

      const detalle = `*PRESUPUESTO PUNTO Y TOMA* ⚡\n\n`+
      `🔧 Trabajo: ${p.nombre}\n`+
      `🔢 Cantidad: ${sess.cantidad} unidad(es)\n`+
      `🪜 Altura: ${sess.altura ? 'Sí (+$${p.altura_extra})' : 'No'}\n`+
      `📍 Zona: ${text}\n`+
      `----------------------\n`+
      `💰 Mano de obra base: $${p.base}\n`+
      `${sess.cantidad>1 ? `➕ Adicional x${sess.cantidad-1}: $${p.por_unidad*(sess.cantidad-1)}\n` : ''}`+
      `${sess.altura && p.altura_extra>0 ? `➕ Extra altura: $${p.altura_extra}\n` : ''}`+
      `----------------------\n`+
      `*TOTAL ESTIMADO: $${total}*\n\n`+
      `_Incluye mano de obra. Materiales no incluidos salvo que aclares que los tenés._\n`+
      `_Presupuesto válido 7 días._`;

      await send(from, detalle);
      await sendButtons(from, `¿Te sirve este presupuesto?`, [
        {id:'si_cristian', title:'✅ Sí, hablar con Cristian'},
        {id:'no_otro', title:'❌ No, otro precio'},
        {id:'otro_trabajo', title:'✏️ Otro trabajo'}
      ]);
      return res.sendStatus(200);
    }

    if(sess.step==='presupuesto'){
      if(text==='si_cristian'){
        // Avisar a Cristian
        const resumen = `🔔 *NUEVA COTIZACIÓN ACEPTADA* 🔔\n\nCliente: +${from}\nTrabajo: ${config.precios[sess.servicio].nombre}\nCantidad: ${sess.cantidad}\nAltura: ${sess.altura?'Sí':'No'}\nZona: ${sess.zona}\nTOTAL: $${sess.presupuesto}\n\n¡Contactalo!`;
        await send(MI_NUMERO, resumen);
        await send(from, `¡Excelente! 🙌\n\nYa le envié tu presupuesto a Cristian. En breve te escribe él personalmente desde su número para coordinar día y horario.\n\nSi querés adelantar, escribile directamente: wa.me/${MI_NUMERO}\n\n¡Gracias por elegir Punto y Toma!`);
        sess.step='encuesta';
        sessions.set(from, sess);
        setTimeout(async()=>{
          await sendButtons(from, `¿Cómo te pareció la atención del bot? Nos ayuda a mejorar 🙏`, [
            {id:'enc_5', title:'⭐⭐⭐⭐⭐ Excelente'},
            {id:'enc_3', title:'⭐⭐⭐ Bien'},
            {id:'enc_1', title:'⭐ Regular'}
          ]);
        }, 2000);
        return res.sendStatus(200);
      }
      if(text==='no_otro' || text==='otro_trabajo'){
        sess.step='menu';
        sessions.set(from, sess);
        await sendList(from, `¡Sin problema! ¿Qué otro trabajo necesitas cotizar?`, "Ver opciones", [
          { title:"Servicios", rows: config.opciones_menu.map(o=>({id:o.id, title:o.titulo, description:o.desc})) }
        ]);
        return res.sendStatus(200);
      }
    }

    if(sess.step==='otro_detalle' || text==='audio_otro'){
      let detalleCliente = '';
      if(type==='text') detalleCliente = msg.text.body;
      else detalleCliente = '[Audio/Mensaje de voz del cliente]';
      
      const aviso = `🔔 *NUEVA CONSULTA - TRABAJO PERSONALIZADO* 🔔\n\nCliente: +${from}\nDetalle: ${detalleCliente}\n\n¡Respondé cuando puedas!`;
      await send(MI_NUMERO, aviso);
      await send(from, `¡Gracias! Le envié tu mensaje a Cristian con tu número.\n\nÉl te va a responder con el presupuesto detallado en breve.\n\nSi es urgente, escribile directo: wa.me/${MI_NUMERO}\n\nSaludos cordiales,\n*Cristian C. - Punto y Toma* ⚡`);
      sess.step='encuesta';
      sessions.set(from, sess);
      return res.sendStatus(200);
    }

    if(sess.step==='encuesta'){
      await send(from, `¡Gracias por tu calificación! 🙏\n\n*Saludos cordiales*\n*Cristian C. - Punto y Toma* ⚡\nVilla General Belgrano`);
      sessions.delete(from);
      return res.sendStatus(200);
    }

    // fallback
    await send(from, `Escribí *hola* para ver el menú de opciones de Punto y Toma ⚡`);
    res.sendStatus(200);

  }catch(err){
    console.error(err);
    res.sendStatus(200);
  }
});

app.get('/', (req,res)=> res.send('Bot Punto y Toma Online ⚡ - '+ new Date().toISOString()));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('Bot online en puerto', PORT));

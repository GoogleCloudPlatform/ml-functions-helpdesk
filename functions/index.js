'use strict';

/*
Copyright 2017 Google Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);
const Language = require('@google-cloud/language');
const language = Language({ apiVersion: 'v1beta2' });
const google = require('googleapis');
const jsforce = require('jsforce');

//[START model_configurations]
const MDL_PROJECT_NAME = <YOUR_PROJECT_HOSTING_MODELS>;
const RESOLUTION_TIME_MODEL_NAME = 'mdl_helpdesk_priority'; # Matches Notebook
const PRIORITY_MODEL_NAME = 'mdl_helpdesk_resolution_time'; # Matches Notebook
const SFDC_URL = <YOUR_SFDC_URL>;
const SFDC_LOGIN = <YOUR_SFDC_LOGIN>;
const SFDC_PASSWORD = <YOUR_SFDC_PASSWORD>;
const SFDC_TOKEN = <YOUR_SFDC_TOKEN>;
//[END model_configurations]

/*
 * PRIORITY
 * Priority prediction using a custom classifying model created in the ml folder
 * calling it through the ML engine API. Because there is no google-cloud nodejs
 * library for this yet, we need to do several steps before we can call it.
 * This write back the priority position in the array to Firebase
 * @params ml : an authenticated ML client
 */
exports.priority = functions.database.ref('/tickets/{ticketID}').onCreate(event => {
  const snapshot = event.data;
  const key = snapshot.key;
  const ticket = snapshot.val();

  if (ticket.hasOwnProperty("pred_priority")){
   console.log("Priority has been done")
   return;
  }

  // Auth
  google.auth.getApplicationDefault(function(err, authClient) {
   if (err) {
     return cb(err);
   }

   //[START ml_engine_auth]
   if (authClient.createScopedRequired && authClient.createScopedRequired()) {
     // https://developers.google.com/identity/protocols/googlescopes#mlv1
     authClient = authClient.createScoped([
     'https://www.googleapis.com/auth/cloud-platform'
     ]);
   }

   //Create authenticated ml engine client
   var ml = google.ml({
     version: 'v1',
     auth: authClient
   });
   //[END ml_engine_auth]

   // Prediction
   ml.projects.predict({
     name: `projects/${MDL_PROJECT_NAME}/models/${PRIORITY_MODEL_NAME}`,
     resource: {
       name: `projects/${MDL_PROJECT_NAME}/models/${PRIORITY_MODEL_NAME}`,
       instances: [
         `${key},${ticket.seniority},${ticket.experience},${ticket.category},
         ${ticket.type},${ticket.impact}`
       ]
     }
   }, function (err, result){
     if (err){
       console.error('ERROR PRIORITY', err)
     }
     if (result.predictions[0].predicted){
       admin.database().ref(`/tickets/${key}/pred_priority`).set(
         result.predictions[0].predicted
       );
     }
   });
  });
});


/*
* RESOLUTION TIME
* Resolution time prediction using a custom regressive model created
* calling it through the ML engine API. Because there is no google-cloud nodejs
* library for this yet, we need to do several steps before we can call it.
* This returns a float representing the amount of days that it will be open
* @params ml : an authenticated ML client
*/
exports.resolutiontime = functions.database.ref('/tickets/{ticketID}').onCreate(event => {

  const snapshot = event.data;
  const key = snapshot.key;
  const ticket = snapshot.val();

  if (ticket.hasOwnProperty("pred_resolution_time")){
    console.log("Resolution time has been done")
    return;
  }

  //[START ml_auth]
  google.auth.getApplicationDefault(function(err, authClient) {
    if (err) {
      return cb(err);
    }

    if (authClient.createScopedRequired && authClient.createScopedRequired()) {
      // Ml Engine does not have its own scope. Needs to use global
      // https://developers.google.com/identity/protocols/googlescopes#mlv1
      authClient = authClient.createScoped([
      'https://www.googleapis.com/auth/cloud-platform'
      ]);
    }

    var ml = google.ml({
      version: 'v1',
      auth: authClient
    });
  //[END ml_auth]

    //[START resolution_prediction]
    ml.projects.predict({
      name: `projects/${MDL_PROJECT_NAME}/models/${RESOLUTION_TIME_MODEL_NAME}`,
      resource: {
        name: `projects/${MDL_PROJECT_NAME}/models/${RESOLUTION_TIME_MODEL_NAME}`,
        instances: [
          `${key},${ticket.seniority},${ticket.experience},${ticket.category},
          ${ticket.type},${ticket.impact}`
        ]
      }
    },
    //[END resolution_prediction]
    function (err, result){
      if (err){
        console.error('ERROR RESOLUTION TIME', err)
      }
      if (result.predictions[0].predicted){
        admin.database().ref(`/tickets/${key}/pred_resolution_time`).set(
          result.predictions[0].predicted
        );
      }
    });
  });
});

/*
 * SENTIMENT
 * NLP Enrichment. This is calling directly the nlp API which has a google-cloud
 * nodeJS library so the authentication is quite straight forward.
 * It writes back to Firebase the tags.
 */
exports.sentiment = functions.database.ref('/tickets/{ticketID}').onCreate(event => {

 const snapshot = event.data;
 const key = snapshot.key;
 const ticket = snapshot.val();

 // Make sure that after we write, it does not call the function again
 if (!ticket){
   console.log("No ticket yet")
   return;
 }
 if (ticket.hasOwnProperty("pred_sentiment")){
   console.log("Sentiment has been done")
   return;
 }

 //[START nlp_prediction]
 const text = ticket.description;
 const document = language.document({content: text});

 document.detectSentiment()
  .then((results) => {
     const sentiment = results[1].documentSentiment;
     admin.database().ref(`/tickets/${key}/pred_sentiment`).set(sentiment.score);
  })
  .catch((err) => {
     console.error('ERROR detectSentiment:', err);
  });
});
//[START nlp_prediction]


/*
* TAGS
* NLP Enrichment. This is calling directly the nlp API which has a google-cloud
* nodeJS library so the authentication is quite straight forward.
* It writes back to Firebase the tags.
*/
exports.tags = functions.database.ref('/tickets/{ticketID}').onCreate(event => {

  const snapshot = event.data;
  const key = snapshot.key;
  const ticket = snapshot.val();

  // Make sure that after we write, it does not call the function again
  if (ticket.hasOwnProperty("tags")){
    console.log("Tagging has been done")
    return;
  }

  const text = ticket.description;
  const document = language.document({content: text});

  document.detectEntities()
   .then((results) => {
      const entities = results[0];
      const writeEntities = []
      entities.forEach((entity) => {
        writeEntities.push(entity.name)
        //admin.database().ref(`/tickets/${key}/tags`).push(entity.name);
      });
      // We overwrite the whole thing to prevent duplicates mentioned above
      admin.database().ref(`/tickets/${key}`).update({'tags':writeEntities});
   })
   .catch((err) => {
      console.error('ERROR detectEntities:', err);
  });
});

/*
 * UPDATESFDC
 * Write to Salesforce some of the ticket data that was created in Firebase and
 * enriched using machine learning.
 */
exports.updateSFDC = functions.database.ref('/tickets/{ticketID}').onWrite(event => {
  const snapshot = event.data;
  const key = snapshot.key;
  const ticket = snapshot.val();

  if (ticket.hasOwnProperty("sfdc_key")){
    console.log("Ticket has been created already");
    return;
  }

  // Makes sure that we do not try to write to Salesforce before the enrichment
  if ((!ticket.pred_priority) || (!ticket.pred_sentiment) || (!ticket.pred_resolution_time)){
    console.log("Still waiting for some values");;
    return;
  }

  var jsforce = require('jsforce');
  var conn = new jsforce.Connection();

  //[START conn_sfdc]
  conn = new jsforce.Connection({
    loginUrl : SFDC_URL
  });
  conn.login(SFDC_LOGIN, SFDC_PASSWORD + SFDC_TOKEN, function(err, res) {
  //[END conn_sfdc]
    if (err) {
      return console.error('SFDC ERROR', err);
    }
    //[START create_ticket_sfdc]
    conn.sobject("Case").create({
      SuppliedEmail: 'user@example.com',
      Description: ticket.description,
      Type: ticket.type,
      Reason: ticket.category,
      Priority: ticket.priority,
      ResolutionTime__c: ticket.t_resolution
    }, function(err, ret) {
    //[END create_ticket_sfdc]
      if (err || !ret.success) {
        return console.error(err, ret);
      }
      admin.database().ref(`/tickets/${key}/sfdc_key`).set(ret.id);
    });
  });
});











